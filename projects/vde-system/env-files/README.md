# Environment Files - DO NOT DELETE
<!-- @armor (Hydration Documentation) -->

**CRITICAL**: These files are REQUIRED dependencies for docker-compose.yml configurations.

## Why These Files Exist

Each VM's `docker-compose.yml` references its env file:

```yaml
env_file:
  - ../../../env-files/{vm-name}.env
```

**Deleting these files breaks Docker Compose and CI/CD.**

## Required Files

All `.env` files in this directory are required. The following were previously deleted by mistake (commit 567e2ca) and had to be restored:

- `python.env` - Required by configs/docker/python/docker-compose.yml
- `redis.env` - Required by configs/docker/redis/docker-compose.yml
- `ruby.env` - Required by configs/docker/ruby/docker-compose.yml

## DO NOT

- ❌ Delete any `.env` files (they are NOT obsolete)
- ❌ Mark as "obsolete" in commits
- ❌ Gitignore these files

## If You Must Change Them

1. Update the corresponding `docker-compose.yml` first
2. Test locally with `docker-compose up`
3. Verify CI passes before merging
