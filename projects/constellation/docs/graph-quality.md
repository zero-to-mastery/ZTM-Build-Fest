# Graph Quality v1

Graph Quality evaluates a proposed visualization. It does not assess the developer, repositories, skills, seniority, or employability.

The Rust/WASM evaluator accepts at most 1 MiB, 512 nodes, 4,096 edges, and 128 groups. `GRAPH_QUALITY_VERSION` is independent of Config, Scene, and Semantic Graph versions. Results include a stable 0–1 score, dimension values, and diagnostic codes.

The five dimensions are legibility, differentiation, evidence coverage, narrative structure, and project coverage. Inputs use deterministic geometry estimates and supplied evidence keys; the evaluator performs no browser text measurement, networking, or generated-code execution. Evaluation is linear for node pairs and bounded quadratic for crossing checks, with crossing diagnostics capped at 1,000.

Candidate creation and story wording remain in JavaScript. Rust supplies deterministic geometry and evidence statistics. Candidate selection compares no more than three candidate views and defaults to Projects when thematic evidence does not improve the candidate. Sparse creation dates disable Journey. A caller should use one fixed reference date when evaluating temporal stories.

The score is selection support, not a claim of objective quality. Diagnostic codes explain common structural penalties. Development inspection is available in the core API. The Studio shows no recommendation or numerical score.
