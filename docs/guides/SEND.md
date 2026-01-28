# /send - Conversational AI in the Outliner

The `/send` command triggers a turn-based conversation with a local LLM (via Ollama).

## Basic Usage

```
## user
- your thoughts here
- another thought

/send
```

Creates `## assistant` block with the LLM response, then immediately creates a new `## user` block so you can continue typing while the model responds.

## Model Selection

### Default Model

Configure in `~/.floatty/config.toml` (or `~/.floatty-dev/config.toml` for dev):

```toml
# Default model for all LLM operations
ollama_model = "qwen2.5:7b"

# Optional: separate model for /send (bigger = smarter)
send_model = "mistral-small:24b"
```

If `send_model` is not set, falls back to `ollama_model`.

### Inline Override

Specify model per-invocation:

```
/send:mistral-small:24b
/send:llama3.3:70b-instruct-q4_K_M
/send:qwen2.5:7b
```

This overrides both `send_model` and `ollama_model` for that single request.

## Context Collection

The `/send` handler collects context from sibling blocks within the same conversation tree. Ancestor `## user` and `## assistant` blocks form the conversation history.

## Model Recommendations

| Model | Size | Best For |
|-------|------|----------|
| `qwen2.5:7b` | 4.7 GB | Quick responses, light hardware |
| `mistral-small:24b` | 14 GB | Better reasoning, more coherent |
| `llama3.3:70b-instruct-q4_K_M` | 42 GB | Best quality, needs GPU RAM |

## Troubleshooting

**"Cannot connect to Ollama"** - Ensure Ollama is running: `ollama serve`

**Slow responses** - Try a smaller model or check if another process is using the GPU

**Model not found** - Pull it first: `ollama pull mistral-small:24b`
