# Dockflow v2

Dockflow deploys your Docker Compose applications, as written, to your own server: zero downtime, a plan before every change, a rollback that always finishes. From your laptop or your CI.

This branch is a rewrite from scratch. It shares no code, no configuration format and no server state with Dockflow 1.x, and offers no migration path: moving a project or a server to v2 is done by hand.

The project is in its design phase. Start with:

- [Vision](docs/design/vision.md): what Dockflow is, who it is for, what it will not do
- [Architecture decisions](docs/design/adr/README.md): one record per decision
- [Specifications](docs/design/README.md#specifications): configuration, server state, events, CLI
- [Roadmap](docs/design/roadmap.md): milestones and their exit criteria
- [Parity with 1.x](docs/design/parity.md): every 1.x feature and its v2 equivalent

## License

MIT
