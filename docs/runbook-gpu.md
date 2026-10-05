# Runbook: обучение System 1 на GPU-сервере

> Порядок действий от «есть сервер» до «плагин использует обученную модель». Все команды запускаются из корня репозитория.
> Данные пользователя (транскрипты) на сервер **не уходят**: только очищенный `tasks.jsonl` и файлы судьи.

## 0. Один раз: доступ

```sh
export AGENTO_GPU_HOST=user@gpu-box          # ssh по ключу, без пароля
export AGENTO_GPU_DIR=~/agento               # каталог на сервере
ssh $AGENTO_GPU_HOST 'nvidia-smi && python3 --version'
```

## 1. Судья на сервере (vLLM, лимит Claude не тратится)

Нужна открытая instruct-модель, которая влезает в 48 ГБ и хорошо понимает код. Подойдёт MoE-кодер ~30B в fp8 или dense ~32B в AWQ.
Перед запуском проверьте актуальные id на Hugging Face. Нужна поддержка guided JSON (`--structured`).

```sh
ssh $AGENTO_GPU_HOST 'pip install -U vllm && nohup vllm serve <hf-model-id> --max-model-len 32768 \
  --gpu-memory-utilization 0.90 --port 8000 > vllm.log 2>&1 &'
ssh -N -L 8000:127.0.0.1:8000 $AGENTO_GPU_HOST &          # туннель на ноутбук
```

## 2. Проверить судью на публичных данных (бесплатно)

```sh
node cli/dist/agento.mjs dataset import twinrouterbench --fetch
node cli/dist/agento.mjs dataset judge --tasks ~/.agento/dataset/public/twinrouterbench.jsonl \
  --backend openai --base-url http://127.0.0.1:8000/v1 --model <hf-model-id> --structured
node cli/dist/agento.mjs dataset validate-judge --judge ~/.agento/dataset/judge/openai-<model>.jsonl \
  --labels ~/.agento/dataset/public/twinrouterbench.jsonl --benchmark swebench
```

Смотрим на SWE-bench (там есть разброс тиров) и выбираем `--threshold`. Цель — under-routing ≤ 5%, то есть судья называет
модель дешевле нужной не чаще чем в 5% случаев. Если цели не достичь ни при каком пороге, судья слаб: попробуйте другую модель.

## 3. Разметить свою историю

```sh
node cli/dist/agento.mjs dataset build --since all
node cli/dist/agento.mjs dataset judge --backend openai --base-url http://127.0.0.1:8000/v1 \
  --model <hf-model-id> --structured --threshold <из шага 2>
```

## 4. Обучение: учитель Laya → ученик → ONNX

```sh
scripts/train-remote.sh            # rsync training/ + датасет, запуск training/run.sh в фоне
scripts/train-remote.sh --status   # лог
scripts/train-remote.sh --pull     # забрать artifacts/<run-id>/ (ученик + report.md)
```

Читаем `training/artifacts/<run-id>/report.md`:
- under-routing на test должен быть ≤ 5% при выбранном пороге;
- экономия при этом пороге должна быть больше нуля;
- сравнение с правилами v1 — ученик должен их обходить.

Если честного порога нет, модель **не ставим**: плагин остаётся на правилах.

## 5. Поставить модель локально

```sh
pip install -e brain                                    # или: cd brain && uv pip install -e .
agento-brain check training/artifacts/<run-id>/student
mkdir -p ~/.agento/brain && cp -r training/artifacts/<run-id>/student ~/.agento/brain/model
agento-brain install                                    # пишет launchd plist и печатает команду запуска
```

Плагин сам найдёт `~/.agento/brain.sock` (`brain: auto`) и покажет в `/agento`, какой классификатор активен.
При любой ошибке или таймауте он вернётся к правилам.

## 6. (Опционально) золотые метки L2

Повторные прогоны тратят лимит Claude. На истории владельца пригодны только 6 задач, и они дорогие (~$20 за прогон).
Разумнее делать L2 на публичных задачах. Перед этим обязательно `--dry-run`:

```sh
node cli/dist/agento.mjs dataset replay --dry-run --max-tasks 10 --budget-usd 10
```
