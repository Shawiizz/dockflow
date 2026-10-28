### Dockflow plan: shop to production

Version `1.4.0`, server `main`.

| | Change | Target | Strategy | Why |
|---|---|---|---|---|
| + | service.create | `worker` |  | new service |
| ~ | service.update | `web` | start-first | image: shop/web:1 \| shop/web:2 |
|  | upload.apply | `/etc/nginx/sites-enabled/shop.conf` |  | changed |

1 to create, 1 to update, 0 to remove.
Unchanged: db.

**Warnings**

- compose: version is obsolete
- db: no health check
