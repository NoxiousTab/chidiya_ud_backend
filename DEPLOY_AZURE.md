# Deploying the Chidiya-ud Backend (Socket.IO + Express) to Azure

This guide covers two production-ready options to host the backend on Azure:

- Option A: Azure App Service (Linux) with WebSockets enabled
- Option B: Azure Container Apps (recommended for containers and scaling)

Both approaches support Socket.IO WebSockets and expose the server on a public URL that you can use from the web app via `NEXT_PUBLIC_SERVER_URL`.

---

## Prerequisites

- Azure subscription
- Azure CLI installed and logged in
  - `az login`
  - `az account set --subscription <SUBSCRIPTION_ID>`
- Node.js 18+ locally (for building, optional if using container build in ACR)
- A resource group name, e.g. `rg-chidiya-ud`
- Server repo available locally (this folder)

Backend env vars used by the server:

- `PORT` (default 4000) — set by platform
- `ROUND_MS` (default 4000)
- `INTERMISSION_MS` (default 1000)

Frontend needs to point to the backend URL:

- `NEXT_PUBLIC_SERVER_URL` (example: `https://<your-app-service>.azurewebsites.net` or `https://<your-containerapp>.<region>.azurecontainerapps.io`)

CORS: The server is currently configured with CORS `origin: '*'` for Socket.IO, which works for testing. You can restrict origins later.

---

## Option A — Azure App Service (Linux)

Best when you want a managed Node app without managing containers. Ensure WebSockets are enabled.

### 1) Prepare a production start command

This project’s server is written in TypeScript (`src/index.ts`). You have three choices:

- Use ts-node in production (simplest): add `ts-node` and `typescript` as dependencies and set `npm start` to `ts-node src/index.ts`.
- Or compile to JS first (recommended): add a build step with `tsc` and run the compiled JS.
- Or use containers (see Option B).

Sample `package.json` (server only) scripts you can adapt:

```json
{
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "express": "^4",
    "socket.io": "^4",
    "cors": "^2",
    "dotenv": "^16"
  },
  "devDependencies": {
    "typescript": "^5",
    "ts-node": "^10"
  }
}
```

Ensure you have a `tsconfig.json` that outputs to `dist`.

### 2) Create resource group and App Service

```bash
RG=rg-chidiya-ud
LOC=eastus
PLAN=asp-chidiya-ud
APP=chidiya-ud-server-$RANDOM

az group create -n $RG -l $LOC
az appservice plan create -g $RG -n $PLAN --sku B1 --is-linux
az webapp create -g $RG -p $PLAN -n $APP --runtime "NODE|18-lts"
```

### 3) Enable WebSockets

```bash
az webapp config set -g $RG -n $APP --web-sockets-enabled true
```

### 4) Configure environment variables

```bash
az webapp config appsettings set -g $RG -n $APP --settings \
  ROUND_MS=4000 \
  INTERMISSION_MS=1000
```

Note: `PORT` is injected by App Service; the server already reads `process.env.PORT`.

### 5) Deploy code via Git or Zip

Option 1 — Local Git deployment:

```bash
az webapp deployment source config-local-git -g $RG -n $APP --query url --output tsv
# Add returned URL as a remote and push the server folder with a proper package.json
```

Option 2 — Zip deploy (if you build locally first):

```bash
npm ci
npm run build
cd dist
zip -r ../server.zip .
cd ..
az webapp deployment source config-zip -g $RG -n $APP --src server.zip
```

### 6) Verify and test

```bash
curl https://$APP.azurewebsites.net/
# Response: { ok: true, service: 'chidiya-ud-server' }
```

Use this URL as `NEXT_PUBLIC_SERVER_URL` in the web frontend.

---

## Option B — Azure Container Apps (recommended)

This option runs the backend as a container. It’s robust and scales well.

### 1) Create Azure resources

```bash
RG=rg-chidiya-ud
LOC=eastus
ACA_ENV=acaenv-chidiya-ud
APP=chidiya-ud-server
ACR=acrchidiyaud$RANDOM

az group create -n $RG -l $LOC
az acr create -g $RG -n $ACR --sku Basic --admin-enabled true
az containerapp env create -g $RG -l $LOC -n $ACA_ENV
```

### 2) Add a Dockerfile (example)

Create `server/Dockerfile` with:

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

Adjust if your build output differs. Ensure `npm run build` compiles TS to `dist`.

### 3) Build and push the image to ACR

```bash
# Log in to ACR
ACR_LOGIN=$(az acr login -n $ACR --expose-token --output tsv --query accessToken)
echo $ACR_LOGIN | docker login $ACR.azurecr.io -u 00000000-0000-0000-0000-000000000000 --password-stdin

# Build and push
IMAGE=$ACR.azurecr.io/chidiya-ud-server:latest
docker build -t $IMAGE ./
docker push $IMAGE
```

Alternatively, use ACR build without local Docker:

```bash
az acr build -g $RG -r $ACR -t chidiya-ud-server:latest .
```

### 4) Deploy to Azure Container Apps

```bash
az containerapp create \
  -g $RG \
  -n $APP \
  --environment $ACA_ENV \
  --image $ACR.azurecr.io/chidiya-ud-server:latest \
  --ingress external --target-port 4000 \
  --env-vars ROUND_MS=4000 INTERMISSION_MS=1000 \
  --registry-server $ACR.azurecr.io --registry-username $(az acr credential show -n $ACR --query username -o tsv) \
  --registry-password $(az acr credential show -n $ACR --query passwords[0].value -o tsv)
```

Get the URL:

```bash
az containerapp show -g $RG -n $APP --query properties.configuration.ingress.fqdn -o tsv
```

Use `https://<fqdn>` as `NEXT_PUBLIC_SERVER_URL`.

WebSockets are supported by Container Apps ingress by default.

### 5) Scale (optional)

```bash
az containerapp update -g $RG -n $APP --min-replicas 1 --max-replicas 3
```

---

## GitHub Actions (optional)

Below is a simple workflow that builds and deploys the server to Azure Container Apps on each push to `main`.

Create `.github/workflows/deploy-containerapp.yml` in your repo:

```yaml
name: Deploy server to Azure Container Apps
on:
  push:
    branches: [ main ]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    env:
      RG: rg-chidiya-ud
      LOC: eastus
      ACA_ENV: acaenv-chidiya-ud
      APP: chidiya-ud-server
      ACR: acrchidiyaud
      IMAGE_NAME: chidiya-ud-server

    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Azure CLI - Ensure ACR exists
        run: |
          az group create -n $RG -l $LOC
          az acr show -g $RG -n $ACR || az acr create -g $RG -n $ACR --sku Basic --admin-enabled true

      - name: Build and push image to ACR
        run: |
          az acr login -n $ACR
          IMAGE=$ACR.azurecr.io/$IMAGE_NAME:${{ github.sha }}
          docker build -t $IMAGE server
          docker push $IMAGE
          echo "IMAGE=$IMAGE" >> $GITHUB_ENV

      - name: Ensure Container Apps env
        run: |
          az containerapp env show -g $RG -n $ACA_ENV || az containerapp env create -g $RG -l $LOC -n $ACA_ENV

      - name: Deploy to Azure Container Apps
        run: |
          az containerapp show -g $RG -n $APP || az containerapp create \
            -g $RG -n $APP --environment $ACA_ENV \
            --ingress external --target-port 4000 \
            --env-vars ROUND_MS=4000 INTERMISSION_MS=1000
          az containerapp update -g $RG -n $APP \
            --image $IMAGE \
            --set-env-vars ROUND_MS=4000 INTERMISSION_MS=1000
```

Set GitHub repository secrets:

- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`

---

## Frontend configuration

Wherever your frontend is hosted (Vercel, Netlify, Azure Static Web Apps, or locally), set:

- `NEXT_PUBLIC_SERVER_URL` to your backend public URL

Example:

```bash
NEXT_PUBLIC_SERVER_URL=https://chidiya-ud-server-12345.azurewebsites.net
# or for Container Apps
NEXT_PUBLIC_SERVER_URL=https://chidiya-ud-server.eastus.azurecontainerapps.io
```

The web app will then connect with:

```ts
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || `${window.location.protocol}//${window.location.hostname}:4000`;
```

---

## Troubleshooting

- 404 or CORS error: ensure the frontend `NEXT_PUBLIC_SERVER_URL` exactly matches the backend URL and that the backend is reachable.
- WebSockets not connecting on App Service: verify WebSockets are enabled (`--web-sockets-enabled true`).
- Socket.IO falling back to polling: that’s expected sometimes behind proxies; performance should still be good. If needed, pin to WebSocket transport on both client and server.
- Port conflicts: do not hardcode port in App Service; Azure sets `PORT` automatically. In containers, expose `4000` and set `--target-port 4000`.
- SSL: both App Service and Container Apps provide HTTPS endpoints automatically.

---

## Cleanup

```bash
az group delete -n rg-chidiya-ud --yes --no-wait
```
