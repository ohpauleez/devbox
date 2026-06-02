
Devbox spec kick-off
====================

Devbox is a simple CLI utility written in TypeScript for creating and managing AWS EC2 machines for development work.
It is installed and updated with NPM or NPX, or as a single executable JavaScript file.

The reason for creating `devbox` is to provide developers an easy way to management multiple EC2 development environments.

This document collects the necessary information to prompt for any open questions and populate an intial OpenSpec specification of the core utility.

### Existing work

The `pasture` directory contains old artifacts and prototypes of the Devbox utility.
These artifacts provide great source material for creating an intial spec, but they will be deleted after the spec is created.
DO NOT directly reference the artifacts in `pasture` from within the spec artifacts.
The spec artifacts should be more robust, more detailed, and more thorough.  The spec artifacts should stand on their own.

The @pasture/plan_with_sshkeys.md describes the core system, the core invariants of different operations, and a general design.
The `pasture/plan_with_sshkeys.md` should be the main document used to populate the initial specification.

If there are additional gaps, vague entries, or unknowns while creating the specification artifacts, ask clarifying questions.

### srs-driven schema

This project uses the SRS-Driven OpenSpec schema defined within @openspec/schemas/srs-driven

The srs-driven schema is focused on high-quality, high-assurance systems with rigorous specification.

Read all of the templates and embedded questions/prompts, identify any gaps with the material from `pasture/plan_with_sshkeys.md`, and ask clarifying questions

### Lightweight formal methods

This project will use evidence-based validation and verification, by applying lightweight formal methods.
Read the details of @docs/lfm.md

### Code maps and coding standards

The specification and documentation generated should include a [code map](https://matklad.github.io/2021/02/06/ARCHITECTURE.md.html)
and use formats similar to [architecture.md](https://github.com/rust-lang/rust-analyzer/blob/d7c99931d05e3723d878bea5dc26766791fa4e69/docs/dev/architecture.md)

The code should strongly conform to the @docs/typescript_style.md coding style guide.  This is a requirement.

/opsx-explore
