# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Install the terminal beta

Install `Node.js`, install the compiled CLI once, then run `dsh` from any directory:

```sh
npm install --global @deepseek-ai/dsh@next
dsh --profile tui
```

To try it without installing, run `npx --yes @deepseek-ai/dsh@next --profile tui`. The terminal beta accepts an optional first prompt, for example `dsh --profile tui "run the tests"`. The Web UI remains available through `dsh web` at `http://127.0.0.1:3080` by default. See the [Web UI guide](docs/user/guide/index.md) or [terminal bundle reference](packages/bundle/tui/README.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
pnpm dsh --profile tui
```

The checkout command runs the compiled `apps/cli/lib/bin.js`, matching the installed package. Contributors who specifically need the TypeScript source launcher can use `pnpm dsh:source <args...>`.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
