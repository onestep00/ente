package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"regexp"
	"sort"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/s3"
	_ "github.com/lib/pq"
)

const previewDataType = "vid_preview"

var previewObjectKeyPattern = regexp.MustCompile(
	`^[0-9]+/file-data/[0-9]+/vid_preview/pv_[0-9A-Za-z]{22}(?:_playlist)?$`,
)

type options struct {
	databaseURL string
	bucket      string
	prefix      string
	profile     string
	endpointURL string
	pathStyle   bool
	gracePeriod time.Duration
	reportPath  string
	applyReport string
	confirmHash string
	maxDeletes  int
}

type plan struct {
	Version      int         `json:"version"`
	GeneratedAt  time.Time   `json:"generatedAt"`
	Cutoff       time.Time   `json:"cutoff"`
	Bucket       string      `json:"bucket"`
	Prefix       string      `json:"prefix"`
	CandidateSum int64       `json:"candidateBytes"`
	Candidates   []candidate `json:"candidates"`
	Summary      planSummary `json:"summary"`
}

type candidate struct {
	Key          string    `json:"key"`
	Size         int64     `json:"size"`
	ETag         string    `json:"etag"`
	LastModified time.Time `json:"lastModified"`
}

type planSummary struct {
	ScannedObjects   int64 `json:"scannedObjects"`
	ScannedBytes     int64 `json:"scannedBytes"`
	CurrentObjects   int64 `json:"currentObjects"`
	TemporaryObjects int64 `json:"temporaryObjects"`
	RecentObjects    int64 `json:"recentObjects"`
	UnknownObjects   int64 `json:"unknownObjects"`
}

func main() {
	if err := run(context.Background(), parseOptions()); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func parseOptions() options {
	var o options
	flag.StringVar(&o.databaseURL, "database-url", os.Getenv("ENTE_DATABASE_URL"), "PostgreSQL DSN (or ENTE_DATABASE_URL)")
	flag.StringVar(&o.bucket, "bucket", "", "S3 bucket containing vid_preview objects")
	flag.StringVar(&o.prefix, "prefix", "", "Optional S3 key prefix to constrain the audit")
	flag.StringVar(&o.profile, "profile", os.Getenv("AWS_PROFILE"), "AWS shared configuration profile")
	flag.StringVar(&o.endpointURL, "endpoint-url", "", "Optional S3-compatible endpoint")
	flag.BoolVar(&o.pathStyle, "path-style", false, "Use path-style S3 addressing")
	flag.DurationVar(&o.gracePeriod, "grace-period", 48*time.Hour, "Minimum object age before it can be deleted")
	flag.StringVar(&o.reportPath, "report", "video-preview-orphans.json", "Dry-run report output")
	flag.StringVar(&o.applyReport, "apply-report", "", "Apply an existing dry-run report")
	flag.StringVar(&o.confirmHash, "confirm-sha256", "", "SHA-256 of the exact report being applied")
	flag.IntVar(&o.maxDeletes, "max-deletes", 500, "Maximum objects deleted in one invocation")
	flag.Parse()
	return o
}

func run(ctx context.Context, o options) error {
	if o.databaseURL == "" {
		return errors.New("database URL is required")
	}
	if o.bucket == "" {
		return errors.New("bucket is required")
	}
	if o.gracePeriod < time.Hour {
		return errors.New("grace period must be at least one hour")
	}

	db, err := sql.Open("postgres", o.databaseURL)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping database: %w", err)
	}

	sess, err := session.NewSessionWithOptions(session.Options{
		Profile:           o.profile,
		SharedConfigState: session.SharedConfigEnable,
		Config: aws.Config{
			Endpoint:         optionalString(o.endpointURL),
			S3ForcePathStyle: aws.Bool(o.pathStyle),
		},
	})
	if err != nil {
		return fmt.Errorf("create S3 session: %w", err)
	}
	client := s3.New(sess)

	if err := requireUnversionedBucket(ctx, client, o.bucket); err != nil {
		return err
	}
	if o.applyReport == "" {
		return writeDryRun(ctx, db, client, o)
	}
	return apply(ctx, db, client, o)
}

func requireUnversionedBucket(ctx context.Context, client *s3.S3, bucket string) error {
	out, err := client.GetBucketVersioningWithContext(ctx, &s3.GetBucketVersioningInput{Bucket: aws.String(bucket)})
	if err != nil {
		return fmt.Errorf("get bucket versioning: %w", err)
	}
	if aws.StringValue(out.Status) != "" {
		return fmt.Errorf("bucket versioning is %q; this draft refuses to delete versioned objects", aws.StringValue(out.Status))
	}
	return nil
}

func writeDryRun(ctx context.Context, db *sql.DB, client *s3.S3, o options) error {
	protected, err := loadProtectedKeys(ctx, db, o.bucket)
	if err != nil {
		return err
	}
	p := plan{
		Version:     1,
		GeneratedAt: time.Now().UTC(),
		Cutoff:      time.Now().UTC().Add(-o.gracePeriod),
		Bucket:      o.bucket,
		Prefix:      o.prefix,
	}
	err = client.ListObjectsV2PagesWithContext(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String(o.bucket),
		Prefix: aws.String(o.prefix),
	}, func(page *s3.ListObjectsV2Output, _ bool) bool {
		for _, object := range page.Contents {
			key := aws.StringValue(object.Key)
			size := aws.Int64Value(object.Size)
			lastModified := aws.TimeValue(object.LastModified).UTC()
			p.Summary.ScannedObjects++
			p.Summary.ScannedBytes += size
			switch classifyObject(key, lastModified, p.Cutoff, protected) {
			case "current":
				p.Summary.CurrentObjects++
			case "temporary":
				p.Summary.TemporaryObjects++
			case "recent":
				p.Summary.RecentObjects++
			case "unknown":
				p.Summary.UnknownObjects++
			case "candidate":
				p.Candidates = append(p.Candidates, candidate{
					Key:          key,
					Size:         size,
					ETag:         aws.StringValue(object.ETag),
					LastModified: lastModified,
				})
				p.CandidateSum += size
			}
		}
		return true
	})
	if err != nil {
		return fmt.Errorf("list objects: %w", err)
	}

	sort.Slice(p.Candidates, func(i, j int) bool { return p.Candidates[i].Key < p.Candidates[j].Key })
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return fmt.Errorf("encode report: %w", err)
	}
	b = append(b, '\n')
	if err := os.WriteFile(o.reportPath, b, 0o600); err != nil {
		return fmt.Errorf("write report: %w", err)
	}
	hash := sha256.Sum256(b)
	fmt.Printf("dry-run report: %s\n", o.reportPath)
	fmt.Printf("candidates: %d objects, %d bytes\n", len(p.Candidates), p.CandidateSum)
	fmt.Printf("report sha256: %s\n", hex.EncodeToString(hash[:]))
	return nil
}

type protectedKeys struct {
	current   map[string]struct{}
	temporary map[string]struct{}
}

func loadProtectedKeys(ctx context.Context, db *sql.DB, bucket string) (protectedKeys, error) {
	p := protectedKeys{current: map[string]struct{}{}, temporary: map[string]struct{}{}}
	rows, err := db.QueryContext(ctx, `
		SELECT user_id, file_id, obj_id
		FROM file_data
		WHERE data_type = $1 AND is_deleted = false AND obj_id IS NOT NULL`, previewDataType)
	if err != nil {
		return p, fmt.Errorf("query current previews: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var userID, fileID int64
		var objectID string
		if err := rows.Scan(&userID, &fileID, &objectID); err != nil {
			return p, fmt.Errorf("scan current preview: %w", err)
		}
		base := fmt.Sprintf("%d/file-data/%d/vid_preview/%s", userID, fileID, objectID)
		p.current[base] = struct{}{}
		p.current[base+"_playlist"] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return p, fmt.Errorf("read current previews: %w", err)
	}

	tempRows, err := db.QueryContext(ctx, `
		SELECT object_key
		FROM temp_objects
		WHERE bucket_id = $1 OR bucket_id IS NULL`, bucket)
	if err != nil {
		return p, fmt.Errorf("query temporary objects: %w", err)
	}
	defer tempRows.Close()
	for tempRows.Next() {
		var key string
		if err := tempRows.Scan(&key); err != nil {
			return p, fmt.Errorf("scan temporary object: %w", err)
		}
		p.temporary[key] = struct{}{}
		p.temporary[key+"_playlist"] = struct{}{}
	}
	return p, tempRows.Err()
}

func classifyObject(key string, modified, cutoff time.Time, protected protectedKeys) string {
	if _, ok := protected.current[key]; ok {
		return "current"
	}
	if _, ok := protected.temporary[key]; ok {
		return "temporary"
	}
	if !previewObjectKeyPattern.MatchString(key) {
		return "unknown"
	}
	if modified.After(cutoff) {
		return "recent"
	}
	return "candidate"
}

func apply(ctx context.Context, db *sql.DB, client *s3.S3, o options) error {
	b, err := os.ReadFile(o.applyReport)
	if err != nil {
		return fmt.Errorf("read report: %w", err)
	}
	hash := sha256.Sum256(b)
	actualHash := hex.EncodeToString(hash[:])
	if o.confirmHash == "" || o.confirmHash != actualHash {
		return fmt.Errorf("confirmation hash mismatch; expected --confirm-sha256 %s", actualHash)
	}
	var p plan
	if err := json.Unmarshal(b, &p); err != nil {
		return fmt.Errorf("decode report: %w", err)
	}
	if p.Version != 1 || p.Bucket != o.bucket {
		return errors.New("report version or bucket does not match")
	}
	if len(p.Candidates) > o.maxDeletes {
		return fmt.Errorf("report has %d candidates, exceeding --max-deletes %d", len(p.Candidates), o.maxDeletes)
	}

	protected, err := loadProtectedKeys(ctx, db, o.bucket)
	if err != nil {
		return err
	}
	deleted := 0
	var deletedBytes int64
	for _, c := range p.Candidates {
		if classifyObject(c.Key, c.LastModified, p.Cutoff, protected) != "candidate" {
			return fmt.Errorf("candidate became protected: %s", c.Key)
		}
		head, err := client.HeadObjectWithContext(ctx, &s3.HeadObjectInput{
			Bucket: aws.String(o.bucket),
			Key:    aws.String(c.Key),
		})
		if err != nil {
			return fmt.Errorf("head %s: %w", c.Key, err)
		}
		if aws.Int64Value(head.ContentLength) != c.Size ||
			aws.StringValue(head.ETag) != c.ETag ||
			!aws.TimeValue(head.LastModified).UTC().Equal(c.LastModified) {
			return fmt.Errorf("object changed after dry-run: %s", c.Key)
		}
		if _, err := client.DeleteObjectWithContext(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(o.bucket),
			Key:    aws.String(c.Key),
		}); err != nil {
			return fmt.Errorf("delete %s: %w", c.Key, err)
		}
		deleted++
		deletedBytes += c.Size
		fmt.Printf("deleted %s (%d bytes)\n", c.Key, c.Size)
	}
	fmt.Printf("deleted total: %d objects, %d bytes\n", deleted, deletedBytes)
	return nil
}

func optionalString(s string) *string {
	if s == "" {
		return nil
	}
	return aws.String(s)
}
