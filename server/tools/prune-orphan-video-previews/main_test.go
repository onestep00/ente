package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestClassifyObject(t *testing.T) {
	now := time.Now().UTC()
	cutoff := now.Add(-48 * time.Hour)
	current := "1/file-data/2/vid_preview/pv_0123456789ABCDEFGHIJKL"
	temporary := "1/file-data/3/vid_preview/pv_0123456789ABCDEFGHIJKL"
	old := "1/file-data/4/vid_preview/pv_0123456789ABCDEFGHIJKL_playlist"
	protected := protectedKeys{
		current:   map[string]struct{}{current: {}},
		temporary: map[string]struct{}{temporary: {}},
	}

	require.Equal(t, "current", classifyObject(current, now.Add(-72*time.Hour), cutoff, protected))
	require.Equal(t, "temporary", classifyObject(temporary, now.Add(-72*time.Hour), cutoff, protected))
	require.Equal(t, "recent", classifyObject(old, now.Add(-time.Hour), cutoff, protected))
	require.Equal(t, "candidate", classifyObject(old, now.Add(-72*time.Hour), cutoff, protected))
	require.Equal(t, "unknown", classifyObject("unrelated/object", now.Add(-72*time.Hour), cutoff, protected))
}

func TestPreviewObjectKeyPattern(t *testing.T) {
	require.True(t, previewObjectKeyPattern.MatchString("12/file-data/34/vid_preview/pv_0123456789ABCDEFGHIJKL"))
	require.True(t, previewObjectKeyPattern.MatchString("12/file-data/34/vid_preview/pv_0123456789ABCDEFGHIJKL_playlist"))
	require.False(t, previewObjectKeyPattern.MatchString("12/file-data/34/vid_preview/not-a-preview"))
	require.False(t, previewObjectKeyPattern.MatchString("12/file-data/34/vid_preview/pv_0123456789ABCDEFGHIJKL/extra"))
}
