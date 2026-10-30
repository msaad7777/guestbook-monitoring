import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";

const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube") ?? true;
const grafanaPassword = config.requireSecret("grafanaPassword");
const nodeAddress = config.get("nodeAddress") ?? "localhost";

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis:6.0.5-alpine",
                        ports: [{ containerPort: 6379 }],
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.67.0",
                        ports: [{ name: "metrics", containerPort: 9121 }],
                        resources: { requests: { cpu: "10m", memory: "32Mi" } },
                    },
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: { name: "redis-leader", labels: redisLeaderLabels },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: "metrics" },
        ],
        selector: redisLeaderLabels,
    },
});

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.67.0",
                        ports: [{ name: "metrics", containerPort: 9121 }],
                        resources: { requests: { cpu: "10m", memory: "32Mi" } },
                    },
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: { name: "redis-replica", labels: redisReplicaLabels },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: "metrics" },
        ],
        selector: redisReplicaLabels,
    },
});

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 80 }],
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    },
                    {
                        name: "apache-exporter",
                        image: "lusotycoon/apache-exporter:v1.0.12",
                        args: ["--scrape_uri=http://localhost/server-status?auto"],
                        ports: [{ name: "metrics", containerPort: 9117 }],
                        resources: { requests: { cpu: "10m", memory: "32Mi" } },
                    },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: { name: "frontend", labels: frontendLabels },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [{ port: 80 }],
        selector: frontendLabels,
    },
});
new k8s.core.v1.Service("frontend-metrics", {
    metadata: { name: "frontend-metrics", labels: frontendLabels },
    spec: {
        ports: [{ name: "metrics", port: 9117, targetPort: "metrics" }],
        selector: frontendLabels,
    },
});

const monitoring = new k8s.helm.v3.Release("monitoring", {
    name: "monitoring",
    chart: "kube-prometheus-stack",
    version: "65.8.1",
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    namespace: "default",
    values: {
        grafana: {
            adminUser: "admin",
            adminPassword: grafanaPassword,
            service: { type: "NodePort", nodePort: 32000 },
        },
        prometheus: {
            prometheusSpec: {
                serviceMonitorSelectorNilUsesHelmValues: false,
            },
        },
    },
});

for (const app of ["frontend", "redis-leader", "redis-replica"]) {
    new k8s.apiextensions.CustomResource(`${app}-monitor`, {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: { name: `${app}-monitor`, namespace: "default" },
        spec: {
            selector: { matchLabels: { app } },
            namespaceSelector: { matchNames: ["default"] },
            endpoints: [{ port: "metrics", interval: "30s" }],
        },
    }, { dependsOn: [monitoring] });
}

new k8s.core.v1.ConfigMap("guestbook-dashboard", {
    metadata: { name: "guestbook-dashboard", namespace: "default", labels: { grafana_dashboard: "1" } },
    data: { "guestbook.json": fs.readFileSync("dashboard.json", "utf8") },
}, { dependsOn: [monitoring] });

export const frontendIp = isMinikube
    ? frontendService.spec.clusterIP
    : frontendService.status.loadBalancer.ingress.apply(i => i[0]?.ip ?? i[0]?.hostname ?? "pending");
export const grafanaUrl = `http://${nodeAddress}:32000`;
export const grafanaUsername = "admin";
export const grafanaAdminPassword = grafanaPassword;
