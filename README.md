# childcolor

## Звук

`sounds/cat-meow.wav` — [Meow.ogg](https://commons.wikimedia.org/wiki/File:Meow.ogg), Dan Crosby, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Запись перекодирована в WAV и приглушена. Адаптированный аудиофайл распространяется на той же лицензии.

## Локальный экспорт PNG

Открывайте `index.html` напрямую или через GitHub Pages. При открытии через `file://`
браузер ограничивает чтение локальных PNG для экспорта. Для этого режима приложение
использует `drawings/local-linework.js`, сгенерированный из оригиналов в `drawings/`.
После добавления или замены PNG обновите этот файл:

```sh
python3 tools/build-local-linework.py
```
