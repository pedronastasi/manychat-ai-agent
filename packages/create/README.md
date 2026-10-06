# create-manychat-ai-agent

```sh
npm create manychat-ai-agent@latest my-agent
```

Generates a tenant project for
[manychat-ai-agent](https://github.com/pedronastasi/manychat-ai-agent): `config/`
from the fictional demo tenant, an offline `.env`, an eval suite, CI, Compose
and Renovate. It depends on the agent at the version of this scaffolder.

Replace `config/` with your own, and keep the repository private: the generated
CI fails when it is public. See
[specs/035](https://github.com/pedronastasi/manychat-ai-agent/blob/main/specs/035-create-scaffolds-a-tenant-project.md).
