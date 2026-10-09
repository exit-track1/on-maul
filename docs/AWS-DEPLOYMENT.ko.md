# 온 마을 AWS 수동 배포

CI/CD 없이 Codex에서 AWS CLI로 인프라를 관리하고, 사용자가 `배포해!`라고 요청하면 애플리케이션 배포를 진행한다. 인프라 생성과 애플리케이션 공개는 별도 단계다.

## 인프라

`infrastructure/onmaul.cfn.json`은 EC2 `t3.small`, 암호화된 20GB gp3 디스크, Elastic IP, 관리용 IAM 역할, 비공개 S3 버킷, Secrets Manager 비밀 저장소를 만든다. 서울 리전의 기본 VPC와 공인 서브넷을 사용한다. EC2, EBS, 공인 IPv4, S3 및 Secrets Manager 사용 요금이 발생한다.

EC2의 관리 명령은 AWS Systems Manager로 실행한다. SSH 키를 만들거나 22번 포트를 열지 않는다. 웹 트래픽용 80/443번 포트만 연다. EC2는 IMDSv2를 사용하며 역할의 애플리케이션 권한은 이 프로젝트의 배포 파일과 비밀 읽기로 제한한다.

생성 직후 `/infra-health`는 인프라 준비 상태만 표시한다. 나머지 요청은 애플리케이션 배포 전까지 503을 반환한다. 이 단계에서는 HTTPS 인증서나 앱 실행을 설정하지 않는다.

```sh
python3 scripts/aws-infra.py provision
python3 scripts/aws-infra.py status
```

필요하면 명령의 하위 작업 앞에 `--profile`, `--region`을 지정한다. 사용자 지정 네트워크는 `provision --vpc-id ... --subnet-id ...`로 지정한다. 서브넷에는 인터넷 게이트웨이로 향하는 공인 경로가 있어야 한다.

계정 확인이 필요한 경우 `.deploy/account-verification-required` 파일로 생성·비밀 업로드를 보류한다. AWS 콘솔에서 의도한 이메일로 로그인한 계정 ID와 CLI의 계정 ID가 일치한다는 근거를 확인한 뒤 해제한다. 보류 중에도 읽기 전용 `status`는 실행할 수 있다.

## HTTPS와 수동 배포

DNS A 레코드가 EC2의 Elastic IP를 가리키면 다음 명령으로 서버 실행 환경과 HTTPS를 준비한다. AWS Systems Manager로 Node.js 24, Certbot, Nginx 설정, systemd 실행 서비스와 인증서 갱신 타이머를 설치한다. 애플리케이션 서비스는 아직 시작하지 않는다.

```sh
python3 scripts/aws-deploy.py prepare
```

Let's Encrypt의 HTTP 검증으로 인증서를 발급한다. 별도 이메일을 등록하지 않으며, 갱신 여부는 하루 두 번 확인한다. 도메인은 인증서의 공개 투명성 기록에 포함된다. `https://도메인/infra-health`로 인증서와 서버 응답을 검증한다.

Docker 배포를 위한 EC2 런타임 준비는 별도 명령으로 실행한다.

```sh
python3 scripts/aws-deploy.py prepare-runtime
```

Node.js 24, Python 3.11, Docker, Git과 jq를 AWS 패키지로 설치하고, Docker Compose와 Buildx는 공식 배포 파일의 고정 버전과 SHA-256을 확인해 설치한다. Docker는 재부팅 후 자동 시작하며, 새 Docker 설정에는 컨테이너별 로그 용량 제한을 적용한다. 수동 설치한 플러그인의 업데이트는 버전과 체크섬을 함께 변경해 진행한다.

Python 가상환경, 공개 Node 기본 이미지의 임시 컨테이너 실행, 임시 scratch 이미지 빌드를 검증하고 테스트 컨테이너와 임시 파일을 제거한다. 앱 소스나 환경변수는 업로드하지 않고 앱 서비스와 현재 버전 링크도 유지한다. 결과는 Git에서 제외한 `.deploy/runtime-ready.json`에 저장한다. 앱은 Docker로 실행하며 systemd가 컨테이너를 관리한다. HTTPS 준비를 다시 실행해도 기존 앱 서비스 설정을 유지한다.

앱 배포 전에 로컬 빌드와 배포 파일 목록만 확인하려면 다음 명령을 쓴다. 결과는 Git에서 제외한 `.deploy/`에 저장하며 AWS 업로드는 수행하지 않는다.

```sh
python3 scripts/aws-deploy.py plan
```

S3 업로드·EC2 다운로드·Docker 이미지 빌드·내부 HTTP까지 검사하려면 `python3 scripts/aws-deploy.py check`를 실행한다. 검사용 앱은 내부 18090번 포트에서 데모 설정으로 실행 후 종료하며, 공개 앱을 활성화하거나 운영 비밀을 읽지 않는다. 검사용 배포 파일은 비공개 S3와 서버 버전 폴더에 남는다.

사용자가 `배포해!`라고 요청한 시점에는 다음 명령을 실행한다.

```sh
python3 scripts/aws-deploy.py deploy
```

배포는 AWS 계정 ID와 추적 중인 앱 소스의 변경 여부를 확인한 뒤 프런트를 빌드하고 서버 타입 검사를 실행한다. 허용한 앱 소스·패키지 잠금 파일·프런트 빌드·합성 fixture와 Docker 빌드 설정만 묶어 비공개 S3에 올린다. 릴리스에는 Git 커밋을 기록한다. EC2는 IAM 역할로 다운로드하고 SHA-256을 검사한 뒤 고정된 공식 Node 이미지로 Docker 이미지를 만든다.

`deploy`는 루트의 Git 제외 `.env`를 Secrets Manager에 별도로 동기화한다. 필수 파일이 없거나 AWS 액세스 키가 포함되면 중단한다. 로컬 파일은 유지하고 업로드 사본의 포트, 공개 URL, 운영 데이터 경로만 서버에 맞춘다. 키와 전화번호는 SSM 명령, S3 배포 파일, 프런트 번들, Docker 이미지에 포함하지 않는다. EC2가 비밀을 읽어 권한 600의 파일로 저장하고 컨테이너에 읽기 전용으로 마운트한다.

소스가 작업 중이면 최신 `origin/main`의 깨끗한 체크아웃을 `--source-root /absolute/path/to/checkout`으로 지정한다. 이때에도 환경변수와 비공개 인프라 상태는 이 저장소 루트에서 읽는다.

새 이미지를 별도 내부 포트에서 전화 기능을 끈 검사용 컨테이너로 실행해 API, HTML, JavaScript, CSS를 확인한다. 새 버전을 가리키는 링크를 교체하고 systemd가 운영 컨테이너를 시작한다. 내부 API 응답을 확인한 뒤 Nginx 연결을 활성화하고, 외부 HTTPS에서 프런트, JavaScript, CSS와 API를 확인한다. 앱은 일반 사용자, 읽기 전용 루트 파일시스템, 1GB 메모리 제한으로 실행한다. 저널·전화 설정·전화 이력은 `/var/lib/onmaul/app-data`에 마운트해 재배포 후 유지한다. 서버 활성화 중 실패하면 이전 버전과 환경 파일, Nginx 설정을 복구한다. 최초 배포 실패 때에는 준비 상태를 유지한다. 외부 접속 검증 단계의 실패는 완료로 보고하지 않으며 SSM 명령 상태와 네트워크를 확인한다.

```sh
python3 scripts/aws-deploy.py verify
python3 scripts/test_aws_deploy.py
```

## 공개 저장소의 설정 분리

| 종류 | 관리 위치 | Git 공개 |
| --- | --- | --- |
| 재현 가능한 인프라 템플릿 | `infrastructure/onmaul.cfn.json` | 가능 |
| 설정 키와 빈 예시 | `infrastructure/runtime.env.example`, `infrastructure/deploy.example.json` | 가능 |
| 계정·리전·서버 ID·고정 IP·버킷·비밀 ARN | `.deploy/aws.json` | 제외 |
| 로컬 개발용 API 키·전화번호 등 | `.env`, `.data/` | 제외 |
| 운영 앱 환경변수 | Secrets Manager `onmaul/prod/runtime-env` | 제외 |
| AWS CLI 로그인·자격 증명 | 사용자 홈의 `~/.aws/` | 제외 |

서버 ID·공인 IP·버킷 이름은 비밀번호가 아니지만 운영 대상 정보를 별도 관리하기 위해 `.deploy/aws.json`에 저장한다. 이 파일과 상위 폴더의 권한은 각각 600과 700으로 설정한다. AWS 계정이 달라지면 관리 스크립트가 실행을 중단한다.

API 키와 토큰은 서버에서만 사용한다. `VITE_*` 환경변수나 브라우저 JavaScript, S3의 정적 배포 파일에 넣지 않는다. 프런트엔드 빌드에 들어간 값은 방문자가 읽을 수 있다.

실제 API 키를 준비한 뒤 로컬 `.env`를 비밀 저장소에 올리는 명령은 다음과 같다. 내용을 터미널에 출력하지 않으며, Git이 추적하는 파일은 거부한다. 명령 실행 시 Secrets Manager에 새 버전이 저장된다.

```sh
python3 scripts/aws-infra.py sync-secrets --file .env
```

AWS 액세스 키는 앱 환경변수에 넣지 않는다. 로컬 배포는 기존 AWS CLI 프로필을 사용하고, EC2 내부에서는 연결된 IAM 역할의 임시 자격 증명을 사용한다. 배포 스크립트가 Secrets Manager의 dotenv 값을 `/etc/onmaul/runtime.env`에 소유자 `onmaul`, 권한 600으로 저장하고 Node.js의 `--env-file`로 읽는다. 서버 포트와 운영 데이터 경로는 배포 설정으로 고정한다. 실제 전화는 `.env`의 `ON_EXECUTION_MODE=hybrid`, `ON_PHONE_ENABLED=yes`와 대상별 번호·동의 설정으로 활성화한다. 원격 화면의 ‘전화 연결 설정’에 같은 `.env`의 `ON_OPERATOR_TOKEN`을 입력하고 적용해야 상태 조회와 발신 명령을 사용할 수 있다. 실제 발신은 화면에서 동의 확인과 시연 시작을 수행할 때 진행한다. 운영 비밀이 갱신된 뒤에는 앱을 재배포해야 실행 중인 프로세스에 적용된다.

`.gitignore`는 이미 공개된 값을 Git 기록에서 삭제하지 않는다. 유출된 키가 있다면 폐기·재발급하고 필요한 경우 기록도 정리한다. 현재 작업에서 Git이 추적하는 `.env`나 개인 키 파일은 발견하지 않았다.

## S3와 정적 웹사이트

현재 S3 버킷은 공개 접근을 차단한 배포 파일 보관용이다. 프런트엔드를 S3에서 직접 제공하려면 HTTPS와 비공개 원본 접근을 지원하는 CloudFront 구성을 추가한다. 이 선택에 따라 메인 도메인의 DNS 대상이 EC2에서 CloudFront로 바뀔 수 있다. API 서버는 EC2에서 실행한다.

## 리소스 정리

해커톤 종료 후에는 사용자 지시에 따라 스택과 보관 데이터를 정리한다. 스택 삭제 시 버킷과 비밀은 보존되므로 데이터 확인 후 별도로 삭제해야 한다. EC2의 루트 디스크는 인스턴스 종료 시 삭제된다. Elastic IP는 스택 삭제 시 해제된다. 정리 전까지 각 리소스의 사용 요금이 계속 발생할 수 있다.

참고: [EC2 IAM 역할](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-ec2.html), [Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html), [S3 웹사이트와 HTTPS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteEndpoints.html).
