# peeshet

Очередь постов для канала «Алёша пишет». Telegram-бот хранит черновики и
расписание в SQLite, показывает владельцу карточки с кнопками и публикует
посты в канал. Сессия Claude Code работает с очередью через HTTP API и
локальный MCP.

## Локальный запуск

```sh
cp .env.example .env   # заполнить BOT_TOKEN, OWNER_ID, API_TOKEN
npm install
npm run dev
```

Проверки: `npm run format && npm run lint:js && npm run check && npm test`.

## MCP

`npm run mcp` запускает stdio-сервер (`src/mcp/`), который ходит в API peeshet.
Инструменты: очередь постов (`list_posts`, `create_post`, `update_post`,
`schedule_post`, `attach_image` и другие) и входящие (`next_inbox`, `ack_inbox`).

Переменные окружения:

- `PEESHET_API_TOKEN` -- токен API (`API_TOKEN` сервера); без него каждый
  инструмент отвечает ошибкой, а сам сервер стартует;
- `PEESHET_API_URL` -- адрес API, по умолчанию `https://peeshet.aimuzov.online`.

Глобально MCP подключён через chezmoi (`home/dot_claude/mcp.json.tmpl`), токен
берётся из KeePassXC. Бот просто копит сообщения владельца (и ставит на них 👀). Как это работает:
пишешь боту, когда удобно; когда хочется разобрать накопленное, открываешь сессию Claude Desktop
в папке `peeshet` и один раз запускаешь `/inbox` (`.claude/commands/inbox.md`): команда обходит всё
накопленное и останавливается. Фонового опроса нет. Черновики из заметок пишет агент `peeshet`
(`.claude/agents/peeshet.md`), он же вызывается командой `/post`.

## Ошибки

Бот и MCP шлют ошибки в Sentry (проект `peeshet`), если задан `SENTRY_DSN`; без
него SDK не включается. Релиз -- `peeshet@<версия из package.json>`, окружение --
`production` (можно переопределить `SENTRY_ENVIRONMENT`).

Уходят необработанные исключения, ошибки обработчиков бота (`bot.catch`), 500 API
и сбои тиков планировщика. Цикл публикации отмечается в cron-мониторе `peeshet-scheduler`:
если тиков нет дольше 5 минут, Sentry заводит issue. Токены бота и API
вычищаются из событий до отправки (`src/sentry.ts`).

## Деплой

Контейнер и туннель до Telegram описаны в `deploy/`, сайт -- в
`infra-server/sites/peeshet.caddy`. Порядок выката: задача 10 плана
`docs/superpowers/plans/2026-10-24-peeshet-deploy-mcp.md` и README `infra-server`.
