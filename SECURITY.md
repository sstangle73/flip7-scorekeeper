# Security

## Reporting a vulnerability

Please report a security problem privately, not in a public issue. This project lives on
[GitLab](https://gitlab.com/sstangle73/flip7-scorekeeper) and is mirrored to GitHub, and
either route works:
- **[Report a vulnerability](https://github.com/sstangle73/flip7-scorekeeper/security/advisories/new)**
  on the GitHub mirror's *Security* tab, or
- a [GitLab issue](https://gitlab.com/sstangle73/flip7-scorekeeper/-/issues/new) marked
  **confidential**.

Only you and the maintainer see either one. Say what you can of:
- what's affected: the scorekeeper page or the *Play together* relay;
- how to reproduce it, or a proof of concept;
- what someone could do with it.

## What happens next

- You'll hear back within 7 days.
- Once it's confirmed, it gets fixed, and a GitHub security advisory is published that
  credits you, unless you'd rather not be named. A CVE is requested through GitHub when
  the problem warrants one.
- Please keep it private until a fix is out, or for 90 days after your report, whichever
  comes first.

This is a one-person project with no bug bounty.

## Supported versions

Only the live scorekeeper, its relay and `main` get fixes.

## What's in scope

The scorekeeper in [`src/`](src/) and the relay in [`server/`](server/). These matter most:
- **Rooms:** joining, watching or changing a room's game without its code, taking the
  host's role, or finding live room codes.
- **Script injection** through a player's name, or anything else another phone sends.
- **A "Just this device" game** contacting any server at all.

Out of scope: someone with a room's code joining it (that's how a room works), and denial
of service by sheer volume.
