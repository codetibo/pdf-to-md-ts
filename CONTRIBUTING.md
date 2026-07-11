# Contributing to pdf-to-md-ts

Thanks for your interest in contributing! 🎉

## Code of Conduct

This project is open and welcoming. Be respectful, constructive, and inclusive.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork:
   ```bash
   git clone https://github.com/your-username/pdf-to-md-ts.git
   cd pdf-to-md-ts
   ```
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Build the package:**
   ```bash
   npm run build
   ```

## Development

### Project structure

```
├── src/
│   ├── index.ts       # Public API exports
│   ├── converter.ts   # Core PDF → Markdown conversion logic
│   └── types.ts       # TypeScript type definitions
├── dist/              # Compiled output (gitignored)
├── package.json
└── tsconfig.json
```

### Running the build

```bash
npm run build
```

The TypeScript source in `src/` compiles to `dist/`.

## Making Changes

1. Create a branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes
3. Ensure the build passes:
   ```bash
   npm run build
   ```
4. Commit with a clear message:
   ```bash
   git commit -m "feat: add support for XYZ"
   ```
5. Push and open a Pull Request:
   ```bash
   git push origin feature/your-feature-name
   ```

## Pull Request Guidelines

- Keep PRs focused on a single change
- Update the README if your change affects the API or usage
- Make sure the TypeScript build passes
- Reference any related issues

## Publishing

Publishing is fully automated via GitHub Actions. See [PUBLISH.md](./PUBLISH.md) for details.

## Questions?

Open an [issue](https://github.com/codetibo/pdf-to-md-ts/issues) — we're happy to help!
