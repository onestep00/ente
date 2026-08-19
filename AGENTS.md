# Ente 작업 규칙

## 적용 범위

- 이 파일은 저장소 전체에 적용한다.
- 문서 변경은 `docs/AGENTS.md`의 인덱스와 문서 규칙을 따른다.
- 실행 상태, 패키지 경로, 모델 버전, 성능 수치는 작업 시점에 다시 측정한다.

## Windows Desktop 빌드

모든 명령은 `C:\Users\jmg29\code\ente\desktop`에서 PowerShell로 실행한다.

1. Windows NSIS 설치본은 아래 단일 스크립트로 빌드한다. 이 스크립트는
   의존성 고정 설치, 공식 `wasm-pack` 복구, renderer·main 빌드, FFmpeg 포함
   검증과 NSIS 패키징을 순서대로 수행한다.

   ```powershell
   .\scripts\build-windows-nsis.ps1
   ```

2. 개별 단계가 필요할 때만 의존성을 고정 설치한다.

   ```powershell
   npx --yes yarn@1.22.22 install --frozen-lockfile
   ```

   설치 뒤에는 `desktop\node_modules\ffmpeg-static\ffmpeg.exe`가 있어야
   한다. Electron Builder의 `beforeBuild` 훅은 누락 시 패키지 설치기를 한 번
   실행하고, 복구하지 못하면 패키징을 실패시킨다.

3. `web/`가 변경된 경우 renderer를 먼저 다시 빌드한다.

   ```powershell
   npx --yes yarn@1.22.22 build-renderer
   ```

4. `desktop/src/` TypeScript 변경은 emit 빌드를 실행한다.

   ```powershell
   .\node_modules\.bin\tsc.cmd
   ```

   `tsc --noEmit`은 타입 검증만 수행한다. `desktop/app/*.js`를 갱신하지
   않으므로 그 명령만 실행한 뒤 Electron Builder를 호출하면 이전 소스가
   패키징된다.

5. 설치·업데이트 검증이 필요한 경우 NSIS를 사용한다.

   ```powershell
   .\node_modules\.bin\electron-builder.cmd --win nsis --x64 `
     --config.compression=store `
     --config.mac.identity=null `
     --config.directories.output="C:\Users\jmg29\builds\ente-nsis"
   ```

   결과물은 `ente-nsis\ente-<version>-x64.exe`이며, unpacked 실행 파일은
   `ente-nsis\win-unpacked\ente.exe`이다. NSIS 패키지는
   `resources\app-update.yml`을 포함한다.

6. 빠른 renderer smoke test만 필요한 경우 출력 디렉터리를 별도로 지정한
   `--dir` 패키지를 사용할 수 있다.

   ```powershell
   .\node_modules\.bin\electron-builder.cmd --win dir --x64 `
     --config.compression=store `
     --config.mac.identity=null `
     --config.directories.output="C:\Users\jmg29\builds\ente-dir"
   ```

   `--dir` 결과에는 일반적으로 `app-update.yml`이 없다. 따라서 updater의
   `ENOENT`를 제품 오류로 판단하지 말고, dir 실행에서는 updater 오류가
   안전하게 기록만 되는지 확인한다. 실제 설치·업데이트 검증에는 NSIS를
   사용한다.

7. 빌드 후에는 다음을 순서대로 확인한다.

   ```powershell
   .\node_modules\.bin\tsc.cmd --noEmit
   git diff --check
   ```

   새 패키지의 `win-unpacked\resources\app.asar`와 실행 파일의 수정
   시각을 확인하고, 새 `--user-data-dir`로 15초 이상 실행한다. 프로세스
   목록에서 main, GPU 또는 software renderer, utility 프로세스가 유지되는지
   확인한다. 기존 실행 중인 Ente 인스턴스와 새 패키지를 섞지 않는다.

## Desktop Jasna 확인

- Desktop Jasna 패키지 버전은 `2.0.0-ente-1.7.23-beta.jasna.2`처럼 private
  release 계열과 실제 기준 업스트림 `1.7.23-beta`, Jasna 개정을 함께 표기한다.
  `2.0.0`은 공개 `1.x`보다 높고, 이 빌드는 `.jasna.` 표식으로 공개 자동
  업데이트를 실행하지 않는다. 공개 설치 파일이 Jasna 통합 빌드를 덮어쓰게
  해서는 안 된다.
- 설정 파일은 `%LOCALAPPDATA%\ente\jasna\config.json`이다.
- 현재 기본값은 `generator=jasna-ente-v5`, `detectionModel=rfdetr-v6`,
  `detectionScoreThreshold=0.15`, `secondaryRestoration=unet-4x`,
  `batchSize=16`, `maxClipSize=2880`, `compileBasicVSRPP=true`이다.
- Jasna 직접 검증은 Ente 업로드와 분리된 격리 입력·출력으로 수행한다.
- 모델 프로세스의 CUDA/NVENC 상태와 Electron renderer 상태를 같은 오류로
  해석하지 않는다. GPU renderer가 시작하지 않아도 Jasna CUDA 프로세스는
  독립적으로 실행될 수 있다.
- `render-process-gone`의 `launch-failed`는 무한 reload하지 않는다. 제품
  빌드는 한 번 `--disable-gpu` software-renderer fallback을 시도하고,
  fallback 이후에도 실패하면 원문 exit code와 stderr를 보존한다.

## 로그와 결과 보존

- 오류 원인은 패턴 검색 결과만으로 판단하지 않는다. 해당 실행의 전체
  stdout, stderr, Ente 로그를 먼저 보존하고 필요한 주변 구간을 함께 읽는다.
- 임시 테스트 패키지·profile·runtime은 저장소 밖에 둔다. 결과를 커밋하지
  않는다.
- 종료한 프로세스와 임시 출력이 남아 있는지 확인한 뒤 다음 실행을 시작한다.
