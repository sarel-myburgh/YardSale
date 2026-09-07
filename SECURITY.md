# Security policy

## Supported versions

The latest release on the `main` branch is supported. Run the newest image
tag when possible so security fixes and dependency updates are included.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Contact the
repository owner privately through GitHub or use GitHub's private security
advisory flow. Include the affected version, reproduction steps, impact, and
any safe mitigation you have identified.

Do not include passwords, federation secrets, buyer contact details, database
files, or uploaded photos in a report.

## Deployment guidance

- Keep `/data` on a private persistent volume and back it up regularly.
- Put the application behind HTTPS when it is reachable outside localhost.
- Do not publish the SQLite database or upload directory directly.
- Use the optional federation control secret only for signed, managed control
  requests; it is stored in the database and never included in exports.
- Use the read-only root filesystem and dropped capabilities from the supplied
  Docker Compose or Quadlet examples.
