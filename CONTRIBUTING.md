# Contributing to YardSale

YardSale is intentionally small and self-hostable. Keep changes focused,
prefer the platform and standard library, and avoid adding services or
configuration that a first-time store owner must manage.

## Local development

Use Node.js 22.5 or newer:

```bash
npm ci
npm run check
npm test
npm run dev
```

The development database is stored in `.yardsale/`; do not commit it or files
from its `uploads/` directory.

## Pull requests

- Explain the user-facing behavior and any data migration.
- Add or update tests for security-sensitive, persistence, and workflow logic.
- Keep HTML output escaped and SQL parameterized.
- Do not add secrets, generated databases, or uploaded media.
- Update the README and `ContainerPlan.md` when deployment behavior changes.

The CI checks must pass before a change is merged.
