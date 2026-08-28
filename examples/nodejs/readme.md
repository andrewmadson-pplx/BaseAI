# BaseAI Node.js Examples

BaseAI Node.js examples.

Please read the [documentation](https://baseai.dev/docs) for more information.

## Perplexity Agent API migration example

Sonar Chat Completions is now [**Agent API**](https://docs.perplexity.ai/docs/agent-api/quickstart). Migrate by September 27, 2026. View the [**Migration Guide**](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview).

The four opt-in local BaseAI Agent aliases are `perplexity:fast` for quick lookups, `perplexity:low` for everyday research, `perplexity:medium` for multi-hop research, and `perplexity:high` for deep research. Choose by workload; do not assume an exact mapping from these historical BaseAI IDs:

-   `perplexity:llama-3.1-sonar-huge-128k-online`
-   `perplexity:llama-3.1-sonar-large-128k-online`
-   `perplexity:llama-3.1-sonar-small-128k-online`
-   `perplexity:llama-3.1-sonar-large-128k-chat`
-   `perplexity:llama-3.1-sonar-small-128k-chat`

Existing Pipes are not migrated automatically. Change only the model ID and review the required sampling fields:

```diff
-model: 'perplexity:llama-3.1-sonar-small-128k-online',
+model: 'perplexity:fast',
 max_tokens: 1000,
 temperature: 0.7,
 top_p: 1,
```

BaseAI sends `max_tokens` as Agent `max_output_tokens` and sends `temperature` and `top_p`; supplied values override preset defaults.

Create `examples/nodejs/.env` with both server-side keys:

```bash
LANGBASE_API_KEY="your-langbase-key"
PERPLEXITY_API_KEY="your-perplexity-key"
```

The local Core caller reads `PERPLEXITY_API_KEY` and passes it to the BaseAI server on `localhost:9000` for the provider request. `LANGBASE_API_KEY` is read by the Pipe configuration. Do not commit either value.

From the repository root:

```bash
pnpm install
pnpm --filter example-nodejs check
pnpm --filter example-nodejs baseai dev
```

In another terminal, run the non-streaming example to print completion text and typed `citationMetadata`, or the separate streaming example to consume the public Core stream:

```bash
pnpm --filter example-nodejs pipe.perplexity.agent
pnpm --filter example-nodejs pipe.perplexity.agent.stream
```

This is public BaseAI OSS local-runtime support only. It does not change, validate, or propose fixes for Langbase-hosted or other proprietary systems. Custom tools and tool replay, streamed citation metadata, background mode, file output, explicit Agent models, `xhigh`, and `wide-research` are unsupported. See the [migration overview](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview) and [field-by-field guide](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to).

## Other examples

```sh
# Install the dependencies
npm install

# Make sure to copy .env.baseai.example file and
# create .env file and add all the API keys in it
cp .env.baseai.example .env

# Run the local baseai dev server to test the examples (uses localhost:9000 port)
npx baseai dev

# Add `pipe` or `tool` or `memory`
npx baseai pipe

# Then test any of the files or a script which runs these files.
npm run pipe.run
npm run pipe.run.stream
npm run pipe.run.stream.loop
npm run pipe.perplexity.agent
npm run pipe.perplexity.agent.stream
npm run pipe.generate.text
npm run pipe.stream.text
```

For more questions, please reach out to us on our new [Discord community](https://langbase.com/discord) or [𝕏/Twitter](https://twitter.com/langbaseinc).
