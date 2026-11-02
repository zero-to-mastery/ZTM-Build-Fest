# Predefined VM Types
<!-- @shared-law (Sovereign Law) -->

All available programming languages and services in the **Sovereign Baseline (1.5.5)**.

[← Back to README](../../README.md)

---

## Language VMs (24 total, SSH ports 2200–2223)

| Name | Aliases | Display Name | SSH Port |
|------|---------|--------------|----------|
| vde-asm | asm, assembler, nasm | Assembler | 2200 |
| vde-c | c | C | 2201 |
| vde-certified-ghost | certified-ghost | Certified Ghost | 2202 |
| vde-cpp | cpp, c++, gcc | C++ | 2203 |
| vde-csharp | csharp, dotnet | C# | 2204 |
| vde-displaytest | displaytest | Go Language | 2205 |
| vde-elixir | elixir, ex, iex | Elixir | 2206 |
| vde-flutter | flutter, dart | Flutter | 2207 |
| vde-go | go, golang | Go | 2208 |
| vde-haskell | haskell, hs | Haskell | 2209 |
| vde-java | java | Java | 2210 |
| vde-js | js, javascript, node | JavaScript | 2211 |
| vde-kotlin | kotlin, kt | Kotlin | 2212 |
| vde-lamp | lamp | LAMP Stack (PHP + MySQL + Nginx) | 2213 |
| vde-lua | lua | Lua | 2214 |
| vde-mean | mean | MEAN Stack (Node + MongoDB) | 2215 |
| vde-php | php | PHP | 2216 |
| vde-python | py, python3 | Python | 2217 |
| vde-ruby | ruby, rb | Ruby | 2218 |
| vde-rust | rust, rs | Rust | 2219 |
| vde-scala | scala | Scala | 2220 |
| vde-swift | swift | Swift | 2221 |
| vde-testport1 | testport1 | Test Port 1 | 2222 |
| vde-testport2 | testport2 | Test Port 2 | 2223 |

---

## Service VMs (8 total, SSH ports 2400–2407)

| Name | Aliases | Display Name | Service Port | SSH Port |
|------|---------|--------------|--------------|----------|
| vde-couchdb | couchdb | CouchDB | 5984 | 2400 |
| vde-jupyterlab | jupyterlab, notebook | JupyterLab | 8888 | 2401 |
| vde-mongodb | mongodb, mongo | MongoDB | 27017 | 2402 |
| vde-mysql | mysql | MySQL | 3306 | 2403 |
| vde-nginx | nginx | Nginx | 80,443 | 2404 |
| vde-postgres | postgres, psql, postgresql | PostgreSQL | 5432 | 2405 |
| vde-rabbitmq | rabbitmq, mq | RabbitMQ | 5672,15672 | 2406 |
| vde-redis | redis | Redis | 6379 | 2407 |

---

## Viewing Available VMs

```zsh
# List all VMs (using unified CLI)
vde list

# List only language VMs
vde list --lang

# List only service VMs
vde list --svc

# Search for specific VMs
vde list python
```

---

## Adding New VM Types

See [Extending VDE](../guides/extending-vde.md) for instructions on adding new languages or services.

---

[← Back to README](../../README.md)
