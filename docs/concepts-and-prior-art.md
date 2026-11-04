# Concepts and prior art

Where the plugin's ideas come from. The plugin inherits most of its design
from the original `.ai-context` stack (same research basis, see that stack's
own `docs/concepts-and-prior-art.md`) and adapts it to an in-process opencode
plugin. All links below were checked for availability on 2026-10-06 (arXiv
titles verified through the arXiv API).

## Papers

| Paper | What we took from it | Where it shows up |
| --- | --- | --- |
| [Agentic RAG: A Survey on Agentic RAG](https://arxiv.org/abs/2501.09136) (Singh et al., 2025) | The calling agent owns the retrieval loop (which tool, when to stop). No second routing LLM. | Small tool set, `repo_structure → semantic_search → read`; [ADR-0020](adr/0020-steer-agent-to-context-tools.md) |
| [Reasoning RAG via System 1 or System 2: A Survey on Reasoning Agentic RAG](https://arxiv.org/abs/2506.10408) (2025) | Retrieval and reasoning interleaved, bounded loops as a recognised pattern. | Tool descriptions state the next step and when to stop |
| [Retrieval-Augmented Code Generation: A Survey with Focus on Repository-Level Approaches](https://arxiv.org/abs/2510.04905) (2025) | Multi-granularity retrieval beats single-level chunk search. | Structure (`repo_structure`), symbols/graph (`analyze_impact`), chunks (`semantic_search`) |
| [CodeRAG](https://lihui.info/doc/EMNLP25.pdf) (EMNLP 2025) | Necessity-driven retrieval, not blind top-k. | Name-precise symbol/graph lookup next to embeddings |
| [GraphCodeAgent](https://arxiv.org/abs/2504.10046) | An agent navigates a structure and dependency graph itself. | `analyze_impact` over the call/import graph |
| [KGCompass](https://arxiv.org/abs/2503.21710) | Narrow the search space with graph paths before the expensive step. | Structure and graph narrow the scope before reading |
| [GraphSearch](https://arxiv.org/abs/2509.22009) | Dual channel (semantic + relational) issued iteratively by the agent. | `semantic_search` (chunks) next to `analyze_impact` (relations) |
| [A2RAG](https://arxiv.org/abs/2601.21162) | Stop retrieval once evidence suffices. | "Stop as soon as you have enough" wording in the agent hint |
| [CodeCompass: Navigating the Navigation Paradox in Agentic Code Intelligence](https://arxiv.org/abs/2602.20048) | Graph navigation beats flat retrieval on architecture-heavy tasks. | Motivation for the graph; a full knowledge graph is deliberately out of scope |
| [Context-Augmented Code Generation Using Programming Knowledge Graphs](https://arxiv.org/abs/2410.18251) | Fine-grained, AST-aware retrieval reduces hallucination. | AST-boundary chunking ([ADR-0013](adr/0013-web-tree-sitter-wasm-for-chunking.md)) |
| [LARGER: Lexically Anchored Repository Graph Exploration and Retrieval](https://arxiv.org/abs/2605.16352) | Lexical anchors into graph nodes, inside the agent's existing loop. | Keyword boost plus graph, no separate graph tool |
| [Matryoshka Representation Learning](https://arxiv.org/abs/2205.13147) | Embeddings truncatable to a prefix. | `embed_dims` truncation + re-normalise |
| [Nomic Embed: Training a Reproducible Long Context Text Embedder](https://arxiv.org/abs/2402.01613) | The embedding model and its mean-pooling requirement. | [ADR-0004](adr/0004-embedding-backend-onnxruntime-node-manual-wiring.md) |

## Projects and tools

| Project | Adopted idea | Where |
| --- | --- | --- |
| [PageIndex](https://github.com/VectifyAI/PageIndex) | Vectorless, section-anchored tree index for long documents. | `search_docs`, [ADR-0009](adr/0009-doc-tree-pageindex-style-markdown-indexing.md) |
| [mcp-local-rag](https://github.com/shinpr/mcp-local-rag) | Keyword boost on top of vector similarity; a status tool; structure-aware chunking of non-code files. | `keyword-rerank.ts` (0.25 weight), `index_status`, data-format chunkers |
| [mcp-rag-server](https://github.com/Daniel-Barta/mcp-rag-server) | Instructions that tell the assistant how to use the tools; a file-browsing tool. | Tool descriptions, agent hint, `repo_structure` |
| [byterover-cli](https://github.com/campfirein/byterover-cli) | Context-tree thinking for agent memory (via the original stack). | Background |
| [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) / [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) | Incremental, error-tolerant parsing. | Chunking and graph extraction; WASM for install reliability |
| [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | Local code-capable embeddings, no API. | Embedding backend, shared HF cache |
| [ONNX Runtime](https://onnxruntime.ai) | Local CPU inference. | `onnxruntime-node` |
| [OpenTelemetry JS](https://opentelemetry.io/docs/languages/js/) | Vendor-neutral telemetry. | API-only, [ADR-0011](adr/0011-otel-bring-your-own-backend-telemetry.md) |
| [opencode plugins](https://opencode.ai/docs/plugins/), [Agent Client Protocol](https://agentclientprotocol.com) | The host and the frontend protocol the plugin must work under. | [opencode-plugin-workarounds.md](opencode-plugin-workarounds.md) |

## Idea → source → decision

| Idea | Origin | Decision |
| --- | --- | --- |
| Agent drives retrieval; no router LLM | Agentic RAG surveys | ADR-0020 |
| Hybrid vector + keyword ranking | mcp-local-rag | ADR-0004 area, `keyword-rerank.ts` |
| Doc tree for long Markdown | PageIndex | ADR-0009 |
| AST chunking, regex fallbacks | Programming-KG paper, original `chunker.py` | ADR-0013, ADR-0016 |
| Call/import graph for blast radius | GraphCodeAgent, CodeCompass | ADR-0006 |
| Local, Docker-free stack | Original stack's operational cost | ADR-0001, ADR-0002 |
| Steering the agent with descriptions and a system hint | Agentic RAG, own adoption measurements | ADR-0010 (superseded in part by ADR-0020), ADR-0023 |
| Out-of-process embedding | Own memory measurements | ADR-0019, ADR-0021 |

## Deliberately not adopted

- ColBERT cross-encoder re-ranking: needs an always-on inference service,
  which is what this plugin removes.
- A routing/summarising second LLM: replaced by the calling agent.
- A full code knowledge graph (CodeCompass-style): deferred.
