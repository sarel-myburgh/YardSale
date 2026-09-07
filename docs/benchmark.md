# v1 resource benchmark

This is an indicative local Docker run, not a capacity guarantee. It used the
release-shaped image on 2026-09-07 with an empty persistent volume, a
read-only root filesystem, a `/tmp` tmpfs, and all Linux capabilities dropped.

| Measure | Observation | v1 target from `ContainerPlan.md` |
| --- | ---: | ---: |
| Image size | 81,978,275 bytes (~78.2 MiB) | Record and review |
| Startup to `/healthz` | 1,026 ms | < 2 seconds |
| Idle container memory | ~16.36 MiB | < 40 MiB target |
| Idle CPU | effectively zero during check | effectively zero |

Repeat the measurement on the deployment host with:

```bash
./deploy/benchmark.sh docker yardsale:benchmark
```

Use `podman` as the first argument on a Podman host. Image size and idle memory
vary with the base image cache, kernel, runtime, and host architecture.
