# Jasna stream integration

작성일: 2026-08-18
갱신일: 2026-09-05
상태: 적용 중
적용 여부: true
폐기 여부: false
적용 범위: Ente Photos Android의 수동 stream recreation 및 Windows Desktop

## 실행 파일과 결과 버전

Windows x64 Desktop은 `ENTE_JASNA_PATH`가 가리키는 Jasna를 우선 사용한다.
현재 native v6 실행 파일은 `--help`에 다음 capability를 게시한다.

```text
--stream-workers
--primary-clip-batch-size
--ente-native-job-v1
```

`--ente-native-job-v1`을 확인한 작업만 `generator=jasna-ente-v6`으로
기록한다. capability가 없는 기존 managed v0.10 경로는
`generator=jasna-ente-v5`로 기록한다. 따라서 이전 실행 파일이 v6 결과로
잘못 표시되지 않는다.

설정 파일은 `%LOCALAPPDATA%\ente\jasna\config.json`이다. 새 기본값과 예제는
v6 generator를 사용한다. 기존 v5 설정은 다른 사용자 설정을 보존한 채 v6로
한 번 갱신된다.

`ENTE_JASNA_PATH`가 없으면 Ente는 검증된 official Jasna v0.10.0 NVIDIA
release를 기존 방식으로 설치할 수 있다. release와 세 archive의 크기 및
SHA-256은 코드에 고정돼 있으며 런타임에서 최신 release를 조회하지 않는다.

## 요청 소유권과 보관 범위

Ente가 작업 선택, 원본 준비, 재시도, 임시 파일, 암호화와 업로드를 소유한다.
Jasna는 현재 받은 요청의 실행, 상태, 취소와 정리만 소유한다.

native control은 요청 metadata를 메모리에 최대 32개 보관한다. 이는 GPU에
동시에 상주하는 영상 수나 model batch 크기가 아니다. Ente는 native
capability가 확인된 경우 영상 처리 항목을 최대 8개 진행시켜 모델별 batch에
입력이 끊기지 않게 한다. 다른 HLS 경로의 상한은 2개다.

Jasna에는 처리 이력 DB, 보관 정책, startup 복구, 자동 재처리가 없다. terminal
응답이 Ente에 전달되면 해당 요청 entry를 제거한다. 과거 job ID를 다시
조회하면 404가 반환된다.

## native 동시 처리 수명

각 영상은 UUID job ID, 별도 job JSON, 별도 출력 디렉터리를 사용한다.

1. Ente가 `POST /api/load`로 job ID와 입력 경로를 보낸다.
2. 진행 상태는 해당 출력의 `jasna-status.json`으로 읽는다.
3. 완료 또는 오류를 본 Ente가 `GET /status?jobId=...`로 terminal 결과를
   확인한다.
4. control은 worker의 최종 consumer와 자원 정리가 끝난 뒤에만 terminal
   응답을 보낸다. 응답 전달 후 entry를 제거한다.
5. 취소 시 `POST /api/stop` 뒤 같은 terminal 정리 장벽을 기다린다.

한 native job의 입력 오류나 일반 작업 오류는 다른 job을 중단하지 않는다.
정리를 제한 시간 안에 확인할 수 없으면 공유 process 상태를 신뢰하지 않고
process를 종료한다. 함께 중단된 Ente 항목은 transient cooldown 뒤 다시
시도한다. capability가 없는 legacy 경로는 요청별 정리 장벽이 없으므로 실패
후 worker를 재시작한다.

Ente는 terminal polling을 중단할 수 있게 묶고 terminal 확인과 취소 HTTP
요청에 시간 상한을 둔다. 응답의 version, job ID와 terminal state가 현재
요청과 일치해야 완료로 인정한다.

## process와 network

Ente FFmpeg utility process는 Jasna control process 하나를 유지한다. Ente의
supervisor executable이 process 수명을 관리하며 Jasna native worker는 Windows
Job Object에 포함된다. control 종료 시 native worker도 종료된다.

Ente는 임의의 loopback port를 고르고 `127.0.0.1`로만 API를 호출한다. 별도
Windows Firewall inbound block rule도 실행 파일에 적용한다.

native v6 경로는 Jasna 설치의 `tools/ffmpeg.exe`를 교체하지 않는다. 기존
v0.10 경로에서만 Ente FFmpeg proxy를 설치해 raw-frame HLS 명령을 기존 Ente
출력 계약에 연결한다. 같은 설치를 native로 갱신하면 Ente가 남긴 manifest를
확인해 기존 proxy로 식별되는 경우 원본으로 복원하고 설치 흔적을 제거한다.
현재 파일이 Ente proxy나 원본과 모두 다르면 복구 파일을 보존하고 경고한다.

## 출력 계약

Ente는 job마다 2초 segment, 4 Mbps 최소, 6 Mbps 목표, 8 Mbps 최대, 최대
60 FPS와 AES-128 key-info 경로를 전달한다. Jasna는 single-file MPEG-TS HLS를
해당 임시 출력 디렉터리에 작성한다.

Ente는 playlist 종료, 전체 duration, byte-range 수와 출력 크기를 검증한다.
검증이 끝난 segment와 playlist만 기존 E2EE preview upload 경로로 올린다.
기존 `vid_preview`는 새 출력의 생성과 업로드가 끝난 뒤 교체된다.

## 기존 stream과 실패 상태

Jasna가 설정된 Desktop은 generator가 없거나 현재 generator와 다른 기존
preview를 backfill에서 다시 생성한다. v6 전환 시 이전 failure policy에서
저장한 local failed ID 집합은 한 번 비워 다시 판정한다.

확정적인 source 형식 오류만 local failed ID에 기록한다. worker, network,
source materialization과 Jasna 가용성 오류는 메모리의 bounded cooldown으로
재시도한다. 이 상태는 Ente의 작업 선택용이며 Jasna의 처리 이력이 아니다.

## mobile recreation 요청

Android **Recreate stream** 동작은 증가하는 `streamRecreateRequest`를 파일의
암호화된 public magic metadata에 기록한다. Desktop은 이를 priority 작업으로
받고 새 preview upload가 끝난 뒤 `streamRecreateAck`를 기록한다. 같은 요청을
반복해서 눌러도 중복 작업을 만들지 않는다.

명시적 mobile 요청은 Desktop의 자동 HLS 설정이 꺼져 있어도 실행된다. 자동
설정은 새 upload 처리와 backfill만 제어한다. 완료 뒤 acknowledgement 쓰기만
실패하면 현재 process에서는 영상을 다시 처리하지 않고 metadata 갱신만 다시
시도한다.

## 임시 입력

HLS 생성은 `SeekableVideoInputProvider`에서 seek 가능한 입력을 얻는다. 로컬
원본은 원래 경로를 사용한다. 다운로드나 stream 입력은 Ente 임시 디렉터리에
materialize하고 lease 해제 때 삭제한다. 각 동시 작업은 고유 입력과 출력
namespace를 사용한다.
