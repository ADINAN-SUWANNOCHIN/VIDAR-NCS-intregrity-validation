# VIDAR — Infra Team Requirements Checklist

## 1. Kubernetes Cluster Spec (minimum)

| Resource | Minimum | Recommended |
|---|---|---|
| Kubernetes version | 1.24 | 1.27+ |
| Worker nodes | 1 node | 2+ nodes |
| CPU per node | 4 cores | 8 cores |
| RAM per node | 8 GB | 16 GB |
| Disk per node | 50 GB | 100 GB |
| Container runtime | containerd 1.6+ | containerd 1.7+ |

> Worker threads (CPU-bound row comparison) scale with CPU.
> 2 Gi memory limit per pod — needs headroom for 7 worker threads.

---

## 2. Network Access Required (from k8s nodes)

| Destination | Port | Purpose |
|---|---|---|
| `172.18.1.92` | 80 / 443 | GitLab API (agent registration) |
| `172.18.1.92` | 5050 | GitLab Container Registry (image pull) |
| SQL Server host | 1433 | Database read access |

---

## 3. Software to Install on the Cluster

- [ ] **nginx Ingress Controller** — `kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/...`
  or install via Helm: `helm install ingress-nginx ingress-nginx/ingress-nginx`

- [ ] **GitLab Agent for Kubernetes (agentk)**
  - Go to GitLab → `bam-ncs-automation/vidar` → Infrastructure → Kubernetes clusters
  - Click "Connect a cluster" → create agent (pick a name, e.g. `bam-cluster`)
  - Run the install command provided by GitLab in the cluster
  - Give us back the **agent name** so we can update `.gitlab-ci.yml`

---

## 4. Secrets to Create (one-time, before first deploy)

### 4a. Image Pull Secret (GitLab registry access)
```bash
kubectl create secret docker-registry gitlab-registry-secret \
  --docker-server=172.18.1.92:5050 \
  --docker-username=<gitlab-service-account-user> \
  --docker-password=<gitlab-access-token> \
  --namespace=default
```
> Use a GitLab service account / deploy token, not a personal account.

### 4b. DB Credentials Secret
```bash
# Copy k8s/secret.template.yaml to k8s/secret.yaml, fill in values, then:
kubectl apply -f k8s/secret.yaml
```
Values needed: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`

---

## 5. DNS / Ingress Hostname

- Provide a hostname for the app (e.g. `vidar.bam.co.th` or an internal DNS name)
- Create a DNS A-record pointing to the Ingress controller's external IP
- We will update `k8s/ingress.yaml` once you confirm the hostname

---

## 6. Things We Need Back from the Infra Team

| Item | Used for |
|---|---|
| GitLab agent name | Update `.gitlab-ci.yml` deploy step |
| Ingress hostname / IP | Update `k8s/ingress.yaml` + Postman collection |
| GitLab deploy token (user+password) | Image pull secret |
| SQL Server host (if different from dev) | Update k8s secret |
