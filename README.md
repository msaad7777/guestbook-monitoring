# Guestbook monitoring

Extends the [Pulumi Kubernetes Guestbook (simple)](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple) with Prometheus and Grafana.

The Guestbook frontend and Redis services remain intact. Prometheus and Grafana are installed with the `kube-prometheus-stack` Helm chart. Exporter sidecars expose metrics from both tiers, and Prometheus discovers them through three ServiceMonitors:

| Component | Exporter | Metrics |
|---|---|---|
| PHP frontend | `apache_exporter`, reading Apache `mod_status` on the pod's localhost | Request count (`apache_accesses_total`), workers, exporter health (`apache_up`) |
| Redis leader and replica | `redis_exporter` | Availability (`redis_up`), commands processed, connected clients |
| All pods | kubelet/cAdvisor, scraped by the chart | CPU and memory usage |

`mod_status` is already enabled in the Guestbook image and only answers requests from inside the pod, so the PHP application is unchanged. The exporter port is published on a separate ClusterIP Service, `frontend-metrics`, so it stays internal when the frontend Service is a LoadBalancer.

A Grafana dashboard named **Guestbook** is provisioned from `dashboard.json`. It shows frontend request rate, frontend CPU and memory, Redis availability, Redis commands per second, and connected clients.

## Requirements

- Node.js and npm
- Pulumi CLI
- Kubernetes cluster and working `kubectl` context (Minikube is sufficient)
- Helm chart repository access during deployment

A small local cluster may require several GB of available RAM for the monitoring stack.

## Deploy

The local backend encrypts secrets with a passphrase. Set it before running Pulumi commands, or enter it when prompted:

```sh
export PULUMI_CONFIG_PASSPHRASE='choose-a-passphrase'
```

```sh
npm install
pulumi login --local
pulumi stack init dev
pulumi config set isMinikube true
pulumi config set nodeAddress "$(minikube ip)"
pulumi config set --secret grafanaPassword 'choose-a-password'
pulumi up
```

Set `isMinikube` to `false` when deploying to a cluster with a cloud LoadBalancer controller. Set `nodeAddress` to an address that can reach the cluster NodePort; for Minikube, use `minikube ip`.

## Access

The Pulumi outputs include `frontendIp`, `grafanaUrl`, `grafanaUsername`, and the secret `grafanaAdminPassword`.

For Minikube, open `http://$(minikube ip):32000` if the node IP is reachable from your machine. Otherwise, use port forwarding:

```sh
kubectl port-forward svc/monitoring-grafana 3000:80
```

Open http://localhost:3000. Username is `admin`; retrieve the password with:

```sh
pulumi stack output grafanaAdminPassword --show-secrets
```

Avoid sharing the password or exposing the NodePort to the public internet.

For the frontend on Minikube:

```sh
kubectl port-forward svc/frontend 8080:80
```

Open http://localhost:8080.

## Verify metrics

Check the monitoring components and exporters:

```sh
kubectl get pods
kubectl get servicemonitors
kubectl get svc monitoring-grafana
kubectl port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
```

Open http://localhost:9090/targets and confirm the `frontend-monitor` (three pods), `redis-leader-monitor`, and `redis-replica-monitor` targets are UP. They can take two to three minutes to appear after `pulumi up` while Prometheus reloads its configuration.

Generate some traffic so the request metrics have data:

```sh
kubectl run load --image=curlimages/curl:8.11.1 --restart=Never --rm -i -- \
  sh -c 'for i in $(seq 500); do curl -s -o /dev/null http://frontend/; done'
```

In the Prometheus expression browser, query:

```promql
sum by (pod) (rate(apache_accesses_total[5m]))
redis_up
sum by (pod) (rate(container_cpu_usage_seconds_total{pod=~"frontend-.*",container="frontend"}[5m]))
```

`apache_accesses_total` should rise by roughly the number of requests sent. `redis_up` should be 1 for both Redis services.

In Grafana, open **Dashboards → Guestbook**, or use the preconfigured Prometheus data source in Explore.

If a target is missing, inspect `kubectl get servicemonitor -o yaml`, the service's `metrics` port, and the matching Kubernetes labels. If `apache_up` or `redis_up` is zero, check the `apache-exporter` or `redis-exporter` container logs.

## Clean up

```sh
pulumi destroy
```

## Notes

The Redis leader is pinned to `redis:6.0.5-alpine` to match the `pulumi/guestbook-redis-replica` image. With a Redis 7 leader, the replica cannot load the RDB format it receives during sync, replication stays down, and the Guestbook shows no saved messages.

Tested on Minikube 1.39 (Kubernetes 1.37) with the Docker driver.

## Scope

Apache `mod_status` reports total requests but not response codes or latency, so the dashboard does not show an error rate or latency. Those would need access-log parsing or instrumenting the PHP application, which was left out to keep the Guestbook image unchanged. The exporter's own scrape of `/server-status` counts as one request per pod every 30 seconds, which is visible as a small baseline in the request rate.
