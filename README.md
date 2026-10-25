# Dockflow v2

Dockflow deploys Docker Compose applications to your own servers, on Docker Swarm, from your laptop or your CI.

This branch is a rewrite from scratch. It shares no code, no configuration format and no server state with Dockflow 1.x, and offers no migration path: moving a project or a server to v2 is done by hand.

The project is in its design phase. Start with:

- [Vision](docs/design/vision.md): what Dockflow is, who it is for, what it will not do
- [Architecture decisions](docs/design/adr/README.md): one record per decision
- [Specifications](docs/design/README.md#specifications): configuration, cluster state, events, CLI
- [Roadmap](docs/design/roadmap.md): milestones and their exit criteria

## License

MIT
