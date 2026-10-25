# Changelog

## [1.0.0](https://github.com/aimuzov/peeshet/compare/v0.1.0...v1.0.0) (2026-10-25)


### ⚠ BREAKING CHANGES

* drop the session nudge, the inbox waits for the owner

### Features

* add docker deploy behind the vpn tunnel ([f4ed99c](https://github.com/aimuzov/peeshet/commit/f4ed99c9d58e45c0b26cbee418d80c3a0fe73343))
* add http api for the session and routines ([13da24a](https://github.com/aimuzov/peeshet/commit/13da24a60aff502320ba43728f77743e240920de))
* add http client for the mcp ([c9d84a0](https://github.com/aimuzov/peeshet/commit/c9d84a02302839a40c5eb18d4c492ea47bfef9f1))
* add moscow time presets and free slot search ([3d8880a](https://github.com/aimuzov/peeshet/commit/3d8880a4a917269c74099bcc0ba7109e98043166))
* add post cards with status line and keyboards ([c9b631f](https://github.com/aimuzov/peeshet/commit/c9b631f798dc06ecc77465f9c30b81e1ffc837e4))
* add post model and telegram limits ([ebc421d](https://github.com/aimuzov/peeshet/commit/ebc421d0d8d216c9aab371daf12ada32e88a18ba))
* add post queue with statuses and revisions ([7f5ca9b](https://github.com/aimuzov/peeshet/commit/7f5ca9b5fc0ed33007eb4aefebc57cc820380f74))
* deploy, local MCP and queue-aware agent ([0e6a420](https://github.com/aimuzov/peeshet/commit/0e6a420b4893004858ba7e207100339fec80cb45))
* drop the session nudge, the inbox waits for the owner ([4475a06](https://github.com/aimuzov/peeshet/commit/4475a0628c254e351ea05ebd217fa7ff75f49280))
* expose the queue as mcp tools ([eab511e](https://github.com/aimuzov/peeshet/commit/eab511e48172a5445b2fb6041abc8bc124f83238))
* handle owner buttons and forward messages to the inbox ([9b947e9](https://github.com/aimuzov/peeshet/commit/9b947e9fd1aa54dec75867025e0987513db90e45))
* keep the owner chat clean ([1fb9262](https://github.com/aimuzov/peeshet/commit/1fb92622c94a6f96bc8406c5efaef21ec85f9462))
* let telegram validate post markup ([0b8ce80](https://github.com/aimuzov/peeshet/commit/0b8ce804ae70422472bf172df41f71a4335ead99))
* let the session work the queue through mcp ([7f418e5](https://github.com/aimuzov/peeshet/commit/7f418e57814775aa324f93ea007af20ba3f1709c))
* publish scheduled posts exactly once ([080703e](https://github.com/aimuzov/peeshet/commit/080703e8dae818f579a336ebc3ce5051b641b6a1))
* send posts and cards as rich messages ([095db65](https://github.com/aimuzov/peeshet/commit/095db65e5bfd0e21ce8f8c8fb69fe57a189ff4bf))
* send posts as text, photo or album with retries ([2246f75](https://github.com/aimuzov/peeshet/commit/2246f753b28baf33e85df7392fecbbf19b625f8f))
* show each post as one card edited in place ([f92034e](https://github.com/aimuzov/peeshet/commit/f92034e30e2b91e87113ba9d09b745b4a5e44001))
* store post photos as keyed media ([72fffb1](https://github.com/aimuzov/peeshet/commit/72fffb1257775e259dad7265ff57c1288911a754))
* tell the owner when an inbox item fails ([638076c](https://github.com/aimuzov/peeshet/commit/638076cab7f933b6022c9511d9058f5606e9d962))
* wire bot, scheduler and api into the server ([305b67b](https://github.com/aimuzov/peeshet/commit/305b67bd9a0507c59ce7a4fc3a9ba2a3cd79d5ed))


### Bug Fixes

* drop photos that never made it into the text ([6380b32](https://github.com/aimuzov/peeshet/commit/6380b321e381c3c4a52d2086fb6a443f08ae6a94))
* harden the api against telegram failures and bad input ([8831312](https://github.com/aimuzov/peeshet/commit/88313122420cd7b06c028b11012435a7171c5647))
* harden the mcp tools ([c19dea8](https://github.com/aimuzov/peeshet/commit/c19dea8fd7ecd45ea9c8a7899e0b04913fe490f3))
* keep the bot token out of logs ([1ae284b](https://github.com/aimuzov/peeshet/commit/1ae284b4a1d44e5b27d18d8c27ff862861f81689))
* keep the connection open after a mid-stream 413 ([398a341](https://github.com/aimuzov/peeshet/commit/398a341a2ee9e2ed72f139f6929fc5bf3abfb655))
* keep the database on the data volume ([3eb2aa8](https://github.com/aimuzov/peeshet/commit/3eb2aa82b10138d6794bfe7b91b999eb8dc3d10e))
* keep the scheduler alive and route owner input precisely ([59673b7](https://github.com/aimuzov/peeshet/commit/59673b7bfddf46939169100d59b27f00afcd1a69))
* keep unpublished posts out of schema resets ([9f93418](https://github.com/aimuzov/peeshet/commit/9f934184058d5c68aeb5e429c0e04fece5a942ef))
* make claim time-aware and wrap multi-step writes in transactions ([91e91e5](https://github.com/aimuzov/peeshet/commit/91e91e56321fc8eacced775275b9df96995ac137))
* name overdue posts in plain text ([d574777](https://github.com/aimuzov/peeshet/commit/d574777e4eb3fd621c5c1ceb0b0b968158d5af33))
* never resend a post that may have reached telegram ([7702a27](https://github.com/aimuzov/peeshet/commit/7702a2781162c0b6d90c9708e19cac47028bf31d))
* publish through the post queue ([24f2aba](https://github.com/aimuzov/peeshet/commit/24f2abae8dd765ab946a59469683635c6dc0ebae))
* refresh cards after publishing state settles ([aa8d363](https://github.com/aimuzov/peeshet/commit/aa8d363df284cefa5266592a5e00521b9ac05909))
* request callback updates explicitly ([be9e106](https://github.com/aimuzov/peeshet/commit/be9e1063f17dcf44ce4ede69c3ba245ec0f5adc2))
* serialize card renders per post ([5d3326c](https://github.com/aimuzov/peeshet/commit/5d3326cc2eec874a2356b21cb9fd16dcf1501a61))
* tell markup errors from chat errors ([f098fd8](https://github.com/aimuzov/peeshet/commit/f098fd849e3b72408d82ea5c2ee52dce914f9933))
* treat a slot day with any post as taken ([c9a7c80](https://github.com/aimuzov/peeshet/commit/c9a7c8095dfcb947f215ac99b46a30cfda42075b))
* validate revert and scheduling ([d10c80e](https://github.com/aimuzov/peeshet/commit/d10c80ed604dada0ecfe99fad19385debd5a1558))

## Changelog
