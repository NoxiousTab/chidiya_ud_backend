# Deploying the Chidiya-ud Backend (Socket.IO + Express) to AWS

This guide covers three production-ready options to host the backend on AWS:

- Option A: Elastic Beanstalk (Node.js on EC2 behind an ALB)
- Option B: ECS Fargate (containers, ALB, scalable)
- Option C: App Runner (containers without managing infra)

All support WebSockets for Socket.IO. Use the deployed URL as `NEXT_PUBLIC_SERVER_URL` in the frontend.

---

## Prerequisites

- AWS account with appropriate permissions
- AWS CLI installed and configured (`aws configure`)
- For container-based options: Docker available locally (or use AWS managed builds)
- Resource naming (examples below use `us-east-1`)

Backend env vars used by the server:

- `PORT` (default 4000) — set by platform/container mapping
- `ROUND_MS` (default 4000)
- `INTERMISSION_MS` (default 1000)

Frontend needs to point to the backend URL:

- `NEXT_PUBLIC_SERVER_URL` (example: `https://<alb-dns>` or `https://<service-id>.<region>.awsapprunner.com`)

Health check endpoint: GET `/` returns `{ ok: true, service: 'chidiya-ud-server' }`.

---

## Option A — Elastic Beanstalk (Node.js)

Best when you want a managed Node app on EC2 without containers. WebSockets work by default behind the Application Load Balancer (ALB).

### 1) Build for production

Compile TS to JS and run from `dist`:

```json
{
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/index.js"
  }
}
```

Ensure `tsconfig.json` outputs to `dist` and `package.json` includes prod dependencies (`express`, `socket.io`, `cors`, `dotenv`).

### 2) Create Beanstalk app and environment

Using the EB CLI (recommended for simplicity):

```bash
# Install EB CLI if needed: pip install awsebcli
REGION=us-east-1
APP=chidiya-ud-server
ENV=chidiya-ud-env

cd server
npm ci
npm run build

# Initialize EB app
eb init $APP --platform node.js --region $REGION

# Create environment with load balancer (ALB)
eb create $ENV --elb-type application
```

### 3) Set environment variables

```bash
eb setenv ROUND_MS=4000 INTERMISSION_MS=1000
```

### 4) Deploy

```bash
eb deploy
```

### 5) Get URL and test

```bash
eb status  # shows CNAME like chidiya-ud-env.abcdefghijk.us-east-1.elasticbeanstalk.com
curl https://<CNAME>/
```

Use that URL as `NEXT_PUBLIC_SERVER_URL` in the frontend.

Notes:
- WebSockets are supported by ALB; no special config usually required.
- If you need stricter CORS, update the server CORS origin.

---

## Option B — ECS Fargate (containers, scalable)

Run the backend as a container on Fargate with an ALB for HTTP/WebSockets.

### 1) Dockerfile

Create `server/Dockerfile`:

```Dockerfile
# syntax=docker/dockerfile:1
FROM node:18-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:18-alpine AS builder
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:18-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

### 2) Push image to ECR

```bash
REGION=us-east-1
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REPO=chidiya-ud-server
IMAGE=$AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$REPO:latest

aws ecr create-repository --repository-name $REPO --region $REGION || true
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

docker build -t $IMAGE server
Docker push $IMAGE
```

### 3) Create ECS Fargate service (with ALB)

You can do this via the console (quicker) or CLI. High-level steps:

- Create an ECS cluster (Fargate)
- Create a task definition (Fargate) referencing the ECR image
  - Container port: 4000
  - Env vars: `ROUND_MS`, `INTERMISSION_MS`
- Create an Application Load Balancer (ALB)
  - Target group: HTTP, port 4000, health check path `/`
- Create an ECS service (Fargate) with public ALB
  - Assign security groups (allow inbound 80/443 to ALB; ALB to service on target group)
  - Desired count ≥ 1

Get the ALB DNS name and use `https://<alb-dns>` for `NEXT_PUBLIC_SERVER_URL`.

Notes:
- Ensure listener rules forward 80/443 to the target group
- WebSockets: ALB supports upgrade automatically

---

## Option C — AWS App Runner (containers, simplest managed)

App Runner deploys your container directly and provides an HTTPS URL. It supports WebSockets for Socket.IO.

### 1) Build and push to ECR (reuse from ECS step)

Use the same Dockerfile and ECR push steps as Option B.

### 2) Create App Runner service

Via console or CLI:

```bash
REGION=us-east-1
SERVICE=chidiya-ud-server
REPO=chidiya-ud-server
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
IMAGE=$AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$REPO:latest

aws apprunner create-service \
  --service-name $SERVICE \
  --source-configuration 'ImageRepository={ImageIdentifier="'$IMAGE'",ImageRepositoryType="ECR"},AutoDeploymentsEnabled=true,AuthenticationConfiguration={AccessRoleArn="arn:aws:iam::'$AWS_ACCOUNT_ID':role/AppRunnerECRAccessRole"}' \
  --instance-configuration Cpu=1 vcpu,Memory=2 GB \
  --region $REGION
```

Then set environment variables:

```bash
aws apprunner update-service \
  --service-arn <SERVICE_ARN> \
  --source-configuration 'ImageRepository={ImageIdentifier="'$IMAGE'",ImageRepositoryType="ECR"},AutoDeploymentsEnabled=true,ImageConfiguration={RuntimeEnvironmentVariables=[{Name=ROUND_MS,Value=4000},{Name=INTERMISSION_MS,Value=1000}]}' \
  --region $REGION
```

Get the default HTTPS URL from the output or console and set it as `NEXT_PUBLIC_SERVER_URL`.

Notes:
- App Runner creates HTTPS endpoint automatically
- Health check path defaults to `/`; you can adjust in settings
- WebSockets are supported over HTTPS

---

## GitHub Actions (optional, App Runner)

Build and push to ECR, then update the App Runner service with the new image on pushes to `main`.

Create `.github/workflows/deploy-apprunner.yml`:

```yaml
name: Deploy server to AWS App Runner
on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    env:
      AWS_REGION: us-east-1
      ECR_REPOSITORY: chidiya-ud-server
      SERVICE_NAME: chidiya-ud-server

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS creds (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-region: ${{ env.AWS_REGION }}
          role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}

      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, and push image to ECR
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG server
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          echo "IMAGE=$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> $GITHUB_ENV

      - name: Update App Runner service to new image
        run: |
          SERVICE_ARN=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='${{ env.SERVICE_NAME }}'].ServiceArn" --output text)
          if [ -z "$SERVICE_ARN" ]; then
            echo "App Runner service not found. Create it once manually or via CLI before running the workflow." && exit 1
          fi
          aws apprunner update-service \
            --service-arn $SERVICE_ARN \
            --source-configuration ImageRepository={ImageIdentifier="${IMAGE}",ImageRepositoryType=ECR},AutoDeploymentsEnabled=true,ImageConfiguration={RuntimeEnvironmentVariables=[{Name=ROUND_MS,Value=4000},{Name=INTERMISSION_MS,Value=1000}]}
```

Secrets required:
- `AWS_ROLE_TO_ASSUME` — an IAM role ARN allowing ECR and App Runner actions via OIDC

---

## Frontend configuration

Set the backend URL in the web project:

```bash
NEXT_PUBLIC_SERVER_URL=https://<your-backend-url>
```

Client uses:

```ts
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || `${window.location.protocol}//${window.location.hostname}:4000`;
```

---

## Troubleshooting

- ALB Health check fails: ensure target group health check path is `/` and container listens on 4000.
- WebSockets not upgrading: verify ALB/ELB is Application Load Balancer, listeners forward to target group, and no proxy strips Upgrade headers.
- CORS errors: restrict/adjust CORS origin in the server once you know the frontend domain.
- App Runner 502: check service logs, ensure port mapping is correct (expose 4000) and process listens on `0.0.0.0`.

---

## Cleanup

- Elastic Beanstalk: terminate environment and delete the application
- ECS Fargate: delete service, target group, ALB, task definition, ECR repo
- App Runner: delete the service; optionally delete the ECR image/repo
