# Server clusters and application scaling

Automated setup starts at **Servers → Clusters → a cluster → Enable scaling**. A ready cluster can then run stateless project applications through **Project → Topology → application → Scale**. Networking connects servers; a server cluster groups them; enabling scaling prepares the group to run applications. Creating a group does not install software. The explicit setup action starts the durable installation operation.

The primary UI uses scaling, application instances, server names and health. K3s/Kubernetes versions, pod identifiers, network ranges and logs remain available in expandable technical details. Required firewall rules and actionable setup errors remain visible. Cluster cards show scaling readiness separately from network verification, using the same saved status in list, detail and SSE responses; they do not add polling or imply continuous health monitoring.

The runtime is available to self-hosted fleet administrators, including through the native SDK. It is unavailable in OpenShip Cloud. Existing Docker project deployments and OpenShip Edge continue using their existing adapters. Kubernetes owns pod scheduling, reconciliation, Service load balancing and CoreDNS; OpenShip does not implement those orchestration responsibilities.

## Project deployment cycle

1. Choose a ready cluster, set 1–100 **Instances** and confirm that they can run independently with important data stored outside each instance. Unready clusters link to their setup and cannot be applied. Source builds also need an image repository, such as `ghcr.io/team/api`, and saved registry credentials with push/pull access where required. OCI releases use their existing registry and do not show this extra field. Every eligible node must be able to reach that registry.
2. **Review deployment** saves the target and opens the existing deployment review. Cancelling review leaves the saved target for the next deployment; running instances remain unchanged until deployment succeeds. Source builds use the existing Docker builder on the first control server and publish an immutable image digest. The image's Linux architecture constrains scheduling; building one architecture does not create a multi-platform image.
3. OpenShip creates a project namespace, environment/pull Secrets, a Deployment and a release Service. Requests equal configured CPU/memory limits. Pods spread across eligible hosts when capacity allows. They wait for the configured port to accept TCP connections and remain ready for five seconds. Workers have no port probe.
4. The new release becomes ready before traffic moves. The existing Edge, domain and deployment lifecycle handles public routing, retirement and rollback. A stable internal `app.<project-namespace>.svc.cluster.local` Service points at the current ready web release. Ingress policy admits this project's pods and the selected Edge host; separate projects are not automatically connected.
5. **Apply scaling** creates a configuration release using the active image digest, without rebuilding source. Environment/resource updates, redeploy, history, progress SSE, cancellation, pause/resume and retained-image rollback use the existing deployment machinery. The UI shows current versus requested instance counts and configured per-instance resource limits when available; these are limits, not a claim about free capacity. Allow temporary capacity for the old and new releases together. Saved replica intent can differ from an observed release after a failed deployment or rollback; Apply is an explicit retry.

The topology shows observed instance counts and an expandable view of instances and their server names. Labels such as “Instance 1” are presentation names for the current sorted observation; pod IDs remain the resource identity and are available in technical details. Unready instance edges are inactive. Instance traffic connections describe automatic load balancing and do not open public domain settings. Workers have no traffic distribution node. The displayed check time is a snapshot; refresh or a deployment change reloads it. Rollout progress uses Kubernetes watches with reconnection. Application logs aggregate recent output from all replicas; live log streaming follows up to six replicas, watches for pod replacement and reports that limit.

The private API connection uses verified mutual TLS through a pooled SSH forward. The certificate stays in memory. SSH is the bootstrap/host/API transport, not a per-pod execution or reconciliation mechanism. The HTTP client bounds connections, responses and timeouts, verifies the remote identity before sending a request on both Node and Bun, and never automatically replays an ambiguous mutation. Rollout watch recovery reads current state before resuming.

Migration `0142_project_cluster.sql` stores the cluster binding and replica/image configuration. Deployment snapshots freeze the cluster installation and project identity. Binding changes use optimistic concurrency and share project/runtime locks with deployment and deletion. A project targeting a cluster prevents runtime removal. Full project deletion removes owned releases and the namespace only after checking for persistent storage, custom resources and other unmanaged objects; it refuses to turn a Kubernetes failure into a Docker orphan cleanup job. Registry images remain under the registry owner's retention policy.

This application cycle supports one stateless application or worker per project. Database services have their own lifecycle below; an existing Docker database is never converted by increasing application instances. Compose stacks, arbitrary persistent mounts and Docker private-service links require further integration. Moving a Kubernetes project through Docker host migration or Cloud transfer is refused. The current API/build/Edge gateway is the first control server: automatic gateway failover, highly available public ingress, workload metrics and policy-driven autoscaling are not implemented.

## Database workflow

After selecting a ready cluster for the project, use **Topology → Add database**. The colored catalog offers PostgreSQL and Redis; resource settings appear after choosing an engine. A new database opens its setup panel automatically. The form uses the shared inputs, selector and checkbox components. The topology canvas temporarily collapses the main sidebar; ordinary cluster/network setup pages keep its normal preference.

| Template   | Deployment | Required distinct servers | Behavior                                                                                                           |
| ---------- | ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL | Standalone | 1                         | One persistent instance with authenticated private access.                                                         |
| PostgreSQL | Cluster    | 3–9                       | One primary, streaming replicas and native failover. At least one standby must acknowledge synchronous writes.     |
| Redis      | Standalone | 1                         | One persistent Redis instance.                                                                                     |
| Redis      | Cluster    | 6–18                      | 3–9 shards, each with one replica. Every data instance uses a separate server. A Redis Cluster client is required. |

OpenShip installs verified official CloudNativePG 1.30.0 and Redis Operator 0.26.0 manifests as needed. Database image digests, operator versions and manifest checksums are pinned. PostgreSQL supports Kubernetes 1.34–1.36. Operators own database reconciliation and failover. OpenShip owns declaration, observation, permissions and the user workflow, using the same verified Kubernetes API transport as applications.

The default `openship-local` storage class is provisioned automatically and retains disks until explicit deletion. It is separate from any default storage class. Each instance has its own volume; Redis Cluster also persists each instance's cluster identity. Local capacity is a reservation, not an enforced disk quota. Losing a server loses its local copy, so replication and archives are separate requirements. An existing CSI class can be selected; PostgreSQL volume expansion requires an expandable class. Local reservation changes, Redis volume resizing, volume shrink, engine/mode changes and Redis resharding are refused. PostgreSQL replica counts and resource limits can be changed through **Database settings**.

Setup is a durable operation with saved steps, logs, request identity, generation fencing and leases. Missing capacity, image failures and operator errors stay visible. Readiness requires the expected instances on distinct servers, bound volumes, engine readiness and an authenticated query from the actual application's namespace. The final test covers private DNS and database ingress policy. Retrying inspects existing resources and reuses accepted operations. Controller restart marks abandoned work interrupted; SSE reconnect never starts work.

**Connect application** saves `DATABASE_URL`, `REDIS_URL`, or a chosen environment key. It refuses to overwrite an unrelated variable. **Review application deployment** uses the existing deployment cycle to apply the connection. App updates, scaling and rollbacks do not recreate database data. Database ingress admits its own replicas, the owning application namespace and the required operator traffic. The topology adds an application/database edge only for a saved connection; selecting or moving a node does not change access. PostgreSQL exposes a stable primary host and, for clusters, a separate read-only host. Redis provides a discovery host for a cluster-aware client.

The database view shows observed instance readiness, server names, volumes and the check timestamp. PostgreSQL replication edges use the observed primary. Redis StatefulSet names do not reliably describe elected roles after failover, so they are shown as members without invented replication edges. Status refresh reads the native operator; setup progress streams saved state. This is not continuous health monitoring.

## PostgreSQL backup and recovery

Choose an existing S3-compatible destination under **Backups** and enable it in database settings. OpenShip passes credentials through Kubernetes Secrets. CloudNativePG archives WAL and runs the selected daily (03:00 UTC), hourly or manual schedule, independently of the OpenShip process. Setup verifies an initial backup before completing. **Back up now** saves a durable request; after a controller interruption, Retry adopts the accepted native backup. The configured retention window is 7–365 days.

**Restore backup** creates a separate database on the same cluster at that backup's consistent recovery point, with new application credentials. It preserves the original database, connection and application release. Inspect the recovered data, then switch the application connection and redeploy explicitly. A restore requires the original database name and at least the original volume size. The original destination address remains protected while a database or restore depends on it. This release does not expose arbitrary point-in-time targets or cross-cluster archive discovery.

**Stop and keep data** stops database workloads and retains their volumes. The retained record remains visible and prevents accidental cluster/project cleanup. PostgreSQL archives can still be selected for restoration. Retained local volumes are not automatically reattached to a new database. **Delete database and data** requires the exact name and explicitly reclaims owned persistent storage. It never purges unowned namespace resources or S3 archives. Once permanent deletion begins, retry continues it rather than pretending data can be retained again. Native finalizers and discovery errors are reported during cleanup. Empty operators installed by OpenShip can remain until runtime removal; foreign operators, custom resources and persistent volumes still block that removal.

Redis archive backup/restore, automatic import from existing Docker databases, database major upgrades, automatic Redis resharding and direct resumption from retained local disks remain unavailable. Redis replicas provide availability and do not replace archives. The UI states the Redis archive limitation before creation.

Migrations `0143_cluster_database.sql` and `0144_cluster_database_recovery.sql` store the database lifecycle, encrypted credentials and backup/restore intent. The encrypted columns participate in the existing instance export/import registry. HTTP, native SDK and dashboard use the same operation contracts and project permissions; host-changing operations also require fleet administration.

## Delivered behavior

Setup checks every physical server, installs missing prerequisites through the shared toolchain, inspects existing networks and runtimes, selects unused pod/service ranges, pins the official K3s stable release, verifies the binary checksum and installs private cluster services. The version and ranges are saved before any runtime installation and remain fixed across retries.

Pools of one or two servers have one control server. Pools of three or more have three controls with embedded etcd; additional members are workers. All controls are also schedulable. Selection uses the saved, sorted member IDs and does not rebalance roles automatically. This establishes control-plane quorum; it does not establish replicated application data or guarantee availability across provider failure domains.

The control API and kubelet use the selected private addresses. Pod networking uses Flannel VXLAN over the existing private interface, including a managed WireGuard interface. VXLAN is encrypted when carried by WireGuard; a native provider network retains its existing transport security. The bundled Traefik, ServiceLB and local-path storage components are disabled so setup does not take over Edge ingress or imply durable database storage.

Readiness requires every expected node to report the correct name, cluster label, version and private IP. Disposable pods then run on every node and test internal DNS and HTTP through a ClusterIP service on every node. A failed pod, image pull, DNS lookup or service route fails the operation even if Kubernetes reports all nodes Ready. Verification namespaces are owned and separated by attempt; retries remove leftover test resources.

## Requirements and private firewall rules

| Requirement           | Initial support                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Host                  | Linux amd64/arm64 with systemd and root or passwordless sudo                                                                      |
| Tools                 | Python 3.8+, iproute2 4.15+, iptables 1.8+, curl 7.61+; missing tools install automatically                                       |
| Control capacity      | At least 2 CPUs, approximately 2 GB RAM, and 5 GB free runtime disk space                                                         |
| Worker capacity       | At least 1 CPU, approximately 1 GB RAM, and 5 GB free runtime disk space                                                          |
| Memory                | Memory/process cgroups; swap disabled before setup                                                                                |
| Host firewall         | Unfiltered hosts or raw iptables, including the iptables nft backend                                                              |
| Network               | Distinct private IPv4 addresses, active interfaces with MTU at least 1280, and bidirectional access between every selected member |
| Existing installation | No unrelated Kubernetes/CNI runtime or conflicting listener/owned firewall chain                                                  |
| Downloads             | HTTPS to the K3s release/channel services and GitHub, plus registry access for system and verification images                     |

Native nftables layouts, UFW and firewalld are not supported by this initial K3s setup adapter, even where a network driver supports them. Setup stops before runtime installation on unsupported hosts. It does not disable swap, overwrite another Kubernetes installation or install a generic firewall manager on top of one already active.

OpenShip adds owned host firewall chains. For provider private-network ACLs, the cluster page displays destination ports with the exact private source and destination addresses:

| Destination     | Port          | Allowed source                                                       |
| --------------- | ------------- | -------------------------------------------------------------------- |
| Every node      | UDP 8472      | Other selected nodes, over the private interface                     |
| Every node      | TCP 10250     | Other selected nodes; cluster pods may also reach kubelet internally |
| Control servers | TCP 6443      | Selected nodes; cluster pods may also reach the API internally       |
| Control servers | TCP 2379–2380 | Other control servers only                                           |

Reply traffic is allowed for these connections. These ports must not be exposed publicly. WireGuard provider rules remain the network's existing UDP transport rules; the K3s rules operate inside that tunnel. Native provider ACLs must allow the listed private connections. A successful local prerequisite check cannot prove a provider firewall is open: join and cross-node pod verification perform the actual connectivity checks.

## Persistence, retry and cleanup

Migration `0141_cluster_runtime.sql` stores one runtime per compute cluster. The operation reuses server authorization, inventory/provisioning locks, host machine identity checks, setup logs, controller shutdown recovery and durable SSE. Runtime installation credentials travel through restrictive SSH file writes and are excluded from the database plan, API snapshots and logs.

The browser locks setup until its request settles. A lost start response triggers a read of saved progress. SSE reconnects and page reloads only read state; Retry is explicit. A 90-second lease and generation fence prevent an abandoned controller from publishing progress. Shutdown marks owned work interrupted before aborting it; PostgreSQL startup recovery retains another controller's valid lease. Remote actions also have bounded execution and an ownership lock.

Retries recheck prerequisites and actual installation state, reuse the pinned version and configuration, and start all saved members before waiting for etcd quorum. They neither reset etcd nor silently recreate the cluster. The UI shows dated verification, not continuous health monitoring.

**Remove runtime** has a confirmation and a separate resumable operation. It refuses removal while application workloads, persistent volumes, database custom resources or foreign operators remain, or when it cannot establish that the cluster is empty. Empty database operators and storage provisioning installed by this runtime are recognized by ownership and verified controller ancestry. The empty-cluster check is saved before uninstalling any host so a partially completed removal can resume after control quorum is gone. Completed hosts need not remain reachable. An external administrator must not add workloads once removal has started.

Only the owned installation is removed, with configuration/binary drift and foreign-runtime checks. An affected upstream K3s cleanup script is refused on Tailscale hosts because it changes Tailscale routes. Missing or externally modified cleanup files/data can require repairing the owned installation before continuing; there is no force-wipe action. Shared prerequisite packages remain installed. Docker workloads, Edge and private-network configuration are retained.

Active and failed runtimes retain their server/network dependency. Membership and network changes require runtime cleanup first in this increment. Adding/removing live workers, draining, upgrades and role changes require separate reconciliation workflows and are not yet exposed.

## Remaining delivery stages

1. Extend application-cycle acceptance to controller-process interruption and the live infrastructure cases below. The repeatable Docker/K3s scaling suite covers the application lifecycle on a prepared cluster.
2. Extend backup recovery to Redis and existing Docker database imports, external storage discovery and reviewed major-version upgrades. Engine-native replication uses separate volumes per replica; several database processes must never share a writable database directory.
3. Add cross-cluster archive recovery and explicit recovery of retained local volumes, without replacing existing databases implicitly.
4. Extend the workload adapter to multi-service projects, scoped service connections, live cluster membership changes, metrics, autoscaling and redundant Edge/API gateways.

Kubernetes supplies pod scheduling, Service routing and CoreDNS. OpenShip supplies the user-facing workflow and integrations; it should not implement another scheduler or an independent cluster DNS layer. Edge handles public HTTP/TLS routing, while database operators own database membership and failover.

## Validation boundary

Tests cover host ownership/configuration guards, private firewall generation, prerequisite failures, quorum recovery ordering, cleanup continuation, durable claims and leases, HTTP/native/SDK/SSE parity, input locking and stale progress handling. Workload tests cover image publication, failed rollout/rollback, watch reconnection, namespace ownership/data protection, replica admission, topology observations and API transport on Node and Bun. Host-function tests substitute operating-system mutations and do not install K3s on the development machine.

The [scaling E2E suite](../apps/api/test/e2e/SCALING.md) drives the real HTTP API and SDK against a migrated test database, an authenticated registry, three disposable K3s nodes and the shipped OpenShip Edge. It covers source deployment, public traffic across servers, internal DNS, scaling up/down without rebuilding, environment changes, updates, retained-image rollback, SSE reconnect, cancellation, failed-release retry, worker outage/recovery, pod replacement and project/namespace/route cleanup. The release gate requires this suite to pass before publishing; it can also run manually. Routine pull request and `main` CI runs exclude it. The fixture substitutes host transport and starts from a verified cluster; it does not exercise SSH/systemd installation, provider networking or the browser journey.

An isolated six-node Linux/K3s lab exercised PostgreSQL and Redis standalone/cluster creation, authenticated queries from the application namespace, PostgreSQL growth from three to four instances, S3 backup and restoration of test data with new credentials, and retained-volume versus explicit-purge behavior. With a worker deliberately paused, PostgreSQL promoted a replica and served an acknowledged test write in 82 seconds; Redis recovered a shard's replicated value in 15 seconds. These are test observations, not recovery-time guarantees. Real HTTP/native/SSE tests cover lifecycle and secret boundaries; Chromium checks cover the catalog, submit locking, connection/redeploy separation, restore progress and responsive panels.

Live infrastructure acceptance is still required before calling the entire stack production-proven: one-control and three-control host installation, mixed amd64/arm64 hosts, supported firewall variants, native and WireGuard underlays, concurrent existing Docker traffic, controller/SSH interruption, restart with lost quorum, blocked VXLAN/API paths, and cleanup preserving existing workloads/networking. No production host was provisioned as part of this implementation.

Official references: [requirements](https://docs.k3s.io/installation/requirements), [server configuration](https://docs.k3s.io/cli/server), [embedded etcd HA](https://docs.k3s.io/datastore/ha-embedded), [uninstall behavior](https://docs.k3s.io/installation/uninstall).
