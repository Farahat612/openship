# Scaling acceptance tests

Run the complete application journey with a reachable Linux Docker daemon:

```sh
RUN_DOCKER_E2E=1 E2E_SCOPE=scaling bun run --cwd apps/api test:e2e
```

Docker needs at least 4 GiB RAM and support for privileged containers. The suite
works with the product's Docker socket discovery, including Docker contexts and
`DOCKER_HOST`. It downloads a pinned K3s release and builds the shipped Edge image.
Initial runs need access to the image registries and Alpine package mirrors.

The fixture creates its own Docker network, an authenticated image registry,
one K3s control node, two workers, and OpenShip Edge. Published test ports bind
only to loopback. It uses a migrated, in-memory database and a test owner/PAT.
It never uses the developer's kubeconfig or registered servers. Cleanup removes
only the fixture's containers, volumes and network.

`scaling-full-cycle.e2e.test.ts` exercises:

- Real HTTP authentication, project cluster selection and deployment admission.
- Source build, authenticated image publication and pulling on different nodes.
- Deployment progress over SSE, disconnect and reconnect without duplicate work.
- Public requests through the shipped Edge and the production route writer.
- Scaling from one to three instances and back, without rebuilding.
- Internal DNS and Service access from an actual application pod.
- Environment changes, an application update and retained-image rollback.
- Requests during scale, update, rollback and failed deployment operations.
- Cancellation, a real crashing workload and explicit redeployment.
- Worker unavailability and recovery, plus Kubernetes replacing a deleted pod.
- Project deletion, owned namespace cleanup and removal of its public route.

The crash test shortens the workload's native progress deadline to 20 seconds.
Kubernetes still produces the failure; the test never fabricates a status.
During worker loss, it waits for Kubernetes to detect the unavailable node and
remove its Service endpoints, then requires twelve consecutive public requests
to succeed within two minutes. It records interrupted requests during routing
convergence and checks that successful replies come from surviving nodes.
It does not assert instant failover or uninterrupted traffic during a host outage.

Infrastructure location is the only substituted production seam: the resolver
connects the real Kubernetes and Docker adapters to the disposable lab instead of
SSH hosts. The suite starts at a verified server cluster. It does **not** prove
the SSH/systemd installer, provider firewalls, WireGuard provisioning, a
three-control-server quorum, controller-process crash recovery, browser clicks
or ACME issuance. Database operators and database migration/recovery also need
their own acceptance suite.

The release gate calls `.github/workflows/scaling-e2e.yml` and requires it to pass
before publishing. Routine pull request and `main` CI runs keep the unit/integration
tests and typechecks; they do not start this heavier Docker/K3s suite. You can also
run it manually from GitHub Actions or with the command above. A missing daemon,
failed image pull, setup failure or assertion fails the job. The workflow saves
output and failure diagnostics as an artifact.

Check the tests' types separately from the API's source-only typecheck:

```sh
bunx tsc --noEmit -p apps/api/tsconfig.scaling-e2e.json
```
