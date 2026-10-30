# Guestbook monitoring

Extends the [Pulumi Kubernetes Guestbook (simple)](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple) with Prometheus and Grafana.

The Guestbook frontend and Redis services remain intact. Prometheus and Grafana are installed with the `kube-prometheus-stack` Helm chart. Redis exporter sidecars expose backend metrics through two ServiceMonitors. Kubernetes container metrics provide frontend CPU and memory utilization. The original PHP frontend does not expose HTTP request or error counters, so these are not claimed here.

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

Check the monitoring components and Redis exporters:

```sh
kubectl get pods
kubectl get servicemonitors
kubectl get svc monitoring-grafana
kubectl port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
```

Open http://localhost:9090/targets and confirm the `redis-leader-monitor` and `redis-replica-monitor` targets are UP. They can take two to three minutes to appear after `pulumi up` while Prometheus reloads its configuration. In the Prometheus expression browser, query:

```promql
redis_up
```

For frontend container utilization, query:

```promql
rate(container_cpu_usage_seconds_total{pod=~"frontend-.*",container="frontend"}[5m])
```

In Grafana, use the preconfigured Prometheus data source and the Explore view to query the same metrics.

If a target is missing, inspect `kubectl get servicemonitor -o yaml`, the service's `metrics` port, and the matching Kubernetes labels. If `redis_up` is zero, check the Redis exporter container logs.

## Clean up

```sh
pulumi destroy
```

## Notes

The Redis leader is pinned to `redis:6.0.5-alpine` to match the `pulumi/guestbook-redis-replica` image. With a Redis 7 leader, the replica cannot load the RDB format it receives during sync, replication stays down, and the Guestbook shows no saved messages.

Tested on Minikube 1.39 (Kubernetes 1.37) with the Docker driver.

## Scope

The implementation monitors Redis availability and Kubernetes resource usage. Per-request frontend latency, request count, and HTTP errors would require instrumenting the PHP application or adding a suitable HTTP metrics exporter. For a short exercise, that change was intentionally left out rather than presenting container metrics as application-level telemetry.
