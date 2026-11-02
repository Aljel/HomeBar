# HomeBar · Ночной гербарий

Личный сайт-бар: рецепты и пропорции, вариации с историей версий, меню для гостей с живой очередью заказов
и «Попробуйте» — случайные рецепты из TheCocktailDB / TheMealDB.

- **backend/** — Rust (axum, sqlx + SQLite, reqwest/rustls). Отдаёт API и собранный фронтенд.
- **frontend/** — React 19 + TypeScript + Vite, TanStack Query, без UI-китов.
- **docs/API.md** — контракт API, **docs/DESIGN.md** — дизайн-направление.

## Запуск (Docker)

```bash
cp .env.example .env        # задайте ADMIN_PASSWORD
docker compose up -d --build
```

Откройте `http://homebar.local` (или `http://<ip-компьютера>`, `:8080` тоже работает) с любого устройства в домашней сети.

### Короткий адрес `homebar.local`
Сайт слушает 80-й порт, а имя в сети объявляет скрипт `deploy/homebar-mdns.py` через системный avahi
(без Docker, без root). Включить автозапуск один раз:

```bash
mkdir -p ~/.config/systemd/user
ln -sf "$PWD/deploy/homebar-mdns.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now homebar-mdns
sudo loginctl enable-linger "$USER"   # необязательно: чтобы работало и до входа в систему
```

`.local` открывается на iPhone, Mac, Windows и Linux; некоторые Android-телефоны его не понимают —
им давайте IP (`http://192.168.x.x/menu`), его стоит закрепить за компьютером в настройках роутера (DHCP reservation).
Гости заходят на `/menu`, выбирают напиток и оставляют имя; хозяин видит заказы на `/bar` (вкладка «Стойка»)
(кнопка-ключ внизу/вверху → пароль из `ADMIN_PASSWORD`).

Данные (SQLite + загруженные фото) лежат в volume `homebar-data`. Бэкап:

```bash
docker run --rm -v homebar_homebar-data:/data -v "$PWD":/backup alpine tar czf /backup/homebar-backup.tgz -C /data .
```

| переменная | по умолчанию | |
|---|---|---|
| `ADMIN_PASSWORD` | `homebar` | пароль хозяина |
| `HOMEBAR_PORT` | `8080` | порт на хосте |
| `TZ` | `Europe/Moscow` | |
| `DISCOVER_ENABLED` | `true` | `false` — офлайн-режим без внешних источников |

## Продукты и база рецептов

- `/pantry` («Продукты», только хозяин) — что есть дома. Гостевое меню `/menu` показывает только то, что из этого
  готовится (или с 1–2 недостающими — настройка там же). Сначала то, для чего есть всё. Названия на русском и
  английском сопоставляются автоматически (словарь `backend/data/ingredients.json`, ~650 ингредиентов).
- Кнопка «Загрузить базу» на той же странице импортирует ~580 коктейлей (TheCocktailDB) и ~790 блюд (TheMealDB),
  повторный запуск докачивает только новое.

## Разработка

```bash
cd backend  && DATA_DIR=./data cargo run          # API на :8080
cd frontend && pnpm install && pnpm dev           # Vite проксирует /api и /uploads на :8080
```

Проверки: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`,
`pnpm typecheck && pnpm lint && pnpm test && pnpm build` (см. scripts в `frontend/package.json`).

## Перед выходом в интернет

Сейчас рассчитано на домашнюю сеть. Для публичного деплоя: поставить перед контейнером reverse-proxy с HTTPS
(Caddy/nginx), сменить пароль, учесть, что токен хозяина бессрочный (меняется вместе с паролем), а статус заказа
`GET /api/orders/:id` публичный и id последовательные.
