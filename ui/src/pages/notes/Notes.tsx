import React, { useState } from "react";
import {
  Card,
  Typography,
  Space,
  Tabs,
  Button,
  Divider,
  Row,
  Col,
  Tag,
  Alert,
} from "antd";
import {
  CopyOutlined,
  CheckOutlined,
  GithubOutlined,
  RocketOutlined,
  StarFilled,
  HeartFilled,
  SafetyOutlined,
  ThunderboltOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  ApiOutlined,
  UploadOutlined,
  PlayCircleOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";

const { Paragraph, Text, Title } = Typography;

/* ----------------------------- CodeBlock UI ----------------------------- */

type CodeBlockProps = {
  language?: string;
  code: string;
};

const CodeBlock: React.FC<CodeBlockProps> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // noop
    }
  };

  return (
    <div
      style={{
        position: "relative",
        background: "#0b1220",
        color: "#e5e7eb",
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: "0 12px 30px rgba(2,6,23,0.35)",
        transition: "transform .15s ease, box-shadow .15s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          justifyContent: "space-between",
          padding: "8px 12px",
          background:
            "linear-gradient(90deg, rgba(37,99,235,.25), rgba(99,102,241,.25))",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 8,
              background: "#22c55e",
              display: "inline-block",
            }}
          />
          <Text style={{ color: "#c7d2fe", fontSize: 12 }}>
            {language ?? "code"}
          </Text>
        </div>
        <Button
          size="small"
          type="text"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={onCopy}
          style={{ color: "#e5e7eb" }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 16,
          overflowX: "auto",
          fontSize: 13.5,
          lineHeight: 1.55,
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
};

/* ----------------------------- Example Snippets ----------------------------- */

// Quickstart: Python env
const INSTALL_PY = `python3.11 -m venv .venv
source .venv/bin/activate        # Windows: .venv\\Scripts\\activate
pip install -U pip
pip install -e .
# Required for file uploads:
pip install python-multipart`;

// Sample .env
const ENV_SAMPLE = `# --- Milvus ---
MILVUS_HOST=127.0.0.1
MILVUS_PORT=19530
MILVUS_HEALTH_PORT=9091
# MILVUS_URI=                 # optional: alternative to host/port
# MILVUS_USER=                # optional
# MILVUS_PASSWORD=            # optional

# --- UI ---
UI_PORT=7860

# --- Ingest defaults ---
RAG_MODEL=sentence-transformers/all-MiniLM-L6-v2
DATA_SOURCE_ROOT=./data
UPLOAD_WORKDIR=./uploads

# --- Security ---
ALLOW_REMOTE_UPLOAD=true       # allow browser uploads from other hosts
ALLOW_REMOTE_SYNC=false        # keep /api/sync local-only
# ADMIN_TOKEN=change-me`;

// Bring up Milvus
const DOCKER_UP = `docker compose -f milvus.docker-compose.yml up -d
docker ps
curl -sf http://127.0.0.1:9091/healthz && echo "Milvus healthy"`;

// Run the backend
const RUN_SERVER = `. .venv/bin/activate   # Windows: .venv\\Scripts\\activate
python ui/server.py
# * Milvus Admin UI: http://127.0.0.1:7860`;

// Build the SPA (only if you change frontend)
const BUILD_UI = `# inside repo root
# choose your tool:
pnpm i && pnpm build
# or: npm i && npm run build
# or: yarn && yarn build
# output goes to ui/static, served by FastAPI`;

// Insert & Search via Admin API (server endpoints)
const PY_ADMIN = `import requests, json
BASE = "http://127.0.0.1:7860"

# 1) Insert demo docs (your production ingest is /api/ingest/upload or /api/sync)
requests.post(f"{BASE}/api/rag/insert", json={
    "collection": "documents",
    "docs": [
        {"doc_id": "1", "text": "How do I reset my LDAP password?"},
        {"doc_id": "2", "text": "Postmortem template for production incidents."},
    ],
})

# 2) Semantic search
r = requests.post(f"{BASE}/api/rag/search", json={
    "collection": "documents",
    "query": "Where is the incident root-cause template?",
    "topk": 3
})
print(json.dumps(r.json(), indent=2))`;

const JS_ADMIN = `const BASE = "http://127.0.0.1:7860";

// 1) Insert demo docs
await fetch(\`\${BASE}/api/rag/insert\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    collection: "documents",
    docs: [
      { doc_id: "1", text: "How do I reset my LDAP password?" },
      { doc_id: "2", text: "Postmortem template for production incidents." },
    ],
  }),
});

// 2) Semantic search
const res = await fetch(\`\${BASE}/api/rag/search\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    collection: "documents",
    query: "Where is the incident root-cause template?",
    topk: 3,
  }),
});
console.log(await res.json());`;

const CURL_ADMIN = `# 1) Insert demo docs
curl -s -X POST http://127.0.0.1:7860/api/rag/insert \\
  -H "Content-Type: application/json" \\
  -d '{
    "collection": "documents",
    "docs": [
      { "doc_id": "1", "text": "How do I reset my LDAP password?" },
      { "doc_id": "2", "text": "Postmortem template for production incidents." }
    ]
  }'

# 2) Semantic search
curl -s -X POST http://127.0.0.1:7860/api/rag/search \\
  -H "Content-Type: application/json" \\
  -d '{
    "collection": "documents",
    "query": "Where is the incident root-cause template?",
    "topk": 3
  }' | jq .`;

// Direct PyMilvus search
const PY_PYMILVUS = `from pymilvus import connections, Collection
from sentence_transformers import SentenceTransformer

connections.connect(host="127.0.0.1", port="19530")

c = Collection("documents")  # already created/ingested
c.load()

model = SentenceTransformer("sentence-transformers/paraphrase-MiniLM-L6-v2")
qv = model.encode(["Where is the incident root-cause template?"], normalize_embeddings=True).tolist()

res = c.search(
    qv, "vec",  # choose your vector field
    param={"nprobe": 10},  # IVF example; for HNSW use {"ef": 64}
    limit=5,
    output_fields=["doc_id","text","title","url","meta"]
)
for hits in res:
    for h in hits:
        print(h.id, h.score, h.entity.get("text"))`;

// Upload with progress (frontend)
const AXIOS_PROGRESS = `import axios from "axios";

const fd = new FormData();
fd.append("collection", "documents");
fd.append("model", "sentence-transformers/all-MiniLM-L6-v2");
fd.append("files", fileInput.files[0], fileInput.files[0].name);

const res = await axios.post("/api/ingest/upload", fd, {
  headers: { "Content-Type": "multipart/form-data" },
  onUploadProgress: (evt) => {
    if (!evt.total) return;
    const pct = Math.round((evt.loaded * 100) / evt.total);
    setUploadPct(pct);
  },
});
setProcessingJobId(res.data.job.id);`;

// Job polling (frontend)
const JOB_POLLING = `import { useEffect, useRef, useState } from "react";

export function useJobPolling(jobId?: string) {
  const [job, setJob] = useState<any>(null);
  const ref = useRef<number | null>(null);

  useEffect(() => {
    if (!jobId) return;
    const tick = async () => {
      try {
        const r = await fetch(\`/api/jobs/\${jobId}\`);
        const j = await r.json();
        setJob(j.job);
        if (["done","error"].includes(j.job.status)) {
          if (ref.current) window.clearInterval(ref.current);
          ref.current = null;
        }
      } catch { /* ignore */ }
    };
    tick();
    ref.current = window.setInterval(tick, 1000);
    return () => { if (ref.current) window.clearInterval(ref.current); };
  }, [jobId]);

  return job;
}`;

// Upload via cURL
const CURL_UPLOAD = `curl -X POST http://127.0.0.1:7860/api/ingest/upload \\
  -H "X-Admin-Token: $ADMIN_TOKEN" \\
  -F "collection=documents" \\
  -F "model=sentence-transformers/all-MiniLM-L6-v2" \\
  -F "files=@/path/to/Milvus.md"`;

// LLM usage tabs
const PY_OPENAI = `from openai import OpenAI
from sentence_transformers import SentenceTransformer

client = OpenAI()  # set OPENAI_API_KEY
model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

# 1) Embed & retrieve from Milvus -> top_doc_snippets
prompt = f"Use this context to answer:\\n{\\n\\n.join(top_doc_snippets)}\\n\\nQ: Summarize the incident policy"
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role":"user","content":prompt}],
)
print(resp.choices[0].message.content)`;

const PY_WATSONX = `# pip install ibm-watsonx-ai
from ibm_watsonx_ai.foundation_models import ModelInference
from ibm_watsonx_ai import Credentials

creds = Credentials(url="https://us-south.ml.cloud.ibm.com", api_key="<YOUR_WATSONX_API_KEY>")
params = { "decoding_method": "greedy", "max_new_tokens": 600 }
model = ModelInference(model_id="ibm/granite-13b-chat-v2", params=params, credentials=creds)

prompt = f"Use this context to answer:\\n{\\n\\n.join(top_doc_snippets)}\\n\\nQ: Summarize the incident policy"
out = model.generate(prompt=prompt)
print(out['results'][0]['generated_text'])`;

/* --------------------------------- Page --------------------------------- */

export default function Notes() {
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {/* HERO */}
      <Card
        styles={{ body: { padding: 0 } }}
        style={{
          borderRadius: 16,
          overflow: "hidden",
          background:
            "radial-gradient(1200px 400px at 20% -10%, rgba(59,130,246,0.22), transparent), radial-gradient(900px 300px at 80% 0%, rgba(139,92,246,0.22), transparent)",
        }}
      >
        <div style={{ padding: 24 }}>
          <Row gutter={[24, 24]} align="middle">
            <Col xs={24} md={16}>
              <Space direction="vertical" size={12}>
                <Title level={3} style={{ margin: 0 }}>
                  Milvus Admin UI — Manage, Ingest & RAG in Minutes
                </Title>
                <Paragraph style={{ fontSize: 16 }}>
                  A sleek admin panel and API to create collections, ingest docs, and run semantic
                  search demos on <Text strong>Milvus</Text>. Built with FastAPI + Ant Design.
                </Paragraph>
                <Space wrap>
                  <Tag icon={<DatabaseOutlined />} color="blue">
                    Milvus 2.x
                  </Tag>
                  <Tag icon={<ThunderboltOutlined />} color="purple">
                    Refine + Vite SPA
                  </Tag>
                  <Tag icon={<CloudServerOutlined />} color="geekblue">
                    Upload & Background Jobs
                  </Tag>
                  <Tag icon={<ApiOutlined />} color="cyan">
                    Clean REST API
                  </Tag>
                </Space>
                <Space wrap>
                  <Button
                    type="primary"
                    size="large"
                    icon={<RocketOutlined />}
                    href="#quickstart"
                  >
                    Get Started
                  </Button>
                  <Button
                    size="large"
                    icon={<GithubOutlined />}
                    href="https://github.com/ruslanmv/milvus-admin-ui"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open GitHub
                  </Button>
                  <Button
                    size="large"
                    icon={<StarFilled style={{ color: "#f59e0b" }} />}
                    href="https://github.com/ruslanmv/milvus-admin-ui"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Star the repo
                  </Button>
                </Space>
                <Paragraph type="secondary" style={{ marginTop: 8 }}>
                  Crafted by{" "}
                  <a href="https://ruslanmv.com" target="_blank" rel="noreferrer">
                    Ruslan Magana Vsevolodovna
                  </a>{" "}
                  — <Text code>ruslanmv.com</Text>
                </Paragraph>
              </Space>
            </Col>
            <Col xs={24} md={8}>
              <Card
                style={{ borderRadius: 14, background: "#0b1220", color: "#e5e7eb" }}
                styles={{ body: { color: "#e5e7eb" } }}
              >
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Text style={{ color: "#c7d2fe" }}>Deploy in 3 steps</Text>
                  <CodeBlock language="bash" code={`# 1) Milvus up\ndocker compose -f milvus.docker-compose.yml up -d\n\n# 2) Backend\npython ui/server.py\n\n# 3) Open UI\nhttp://127.0.0.1:7860`} />
                  <Space>
                    <InfoCircleOutlined />
                    <Text type="secondary">
                      Frontend builds to <Text code>ui/static/</Text>, served by FastAPI.
                    </Text>
                  </Space>
                </Space>
              </Card>
            </Col>
          </Row>
        </div>
      </Card>

      {/* HIGHLIGHTS */}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card style={{ borderRadius: 14 }}>
            <Space direction="vertical">
              <Title level={5} style={{ margin: 0 }}>
                Create & Index
              </Title>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Wizard to create collections, pick embedding model & index, and ingest data from
                local paths, uploads, or object storage.
              </Paragraph>
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card style={{ borderRadius: 14 }}>
            <Space direction="vertical">
              <Title level={5} style={{ margin: 0 }}>
                Upload with Progress
              </Title>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Smooth browser upload progress + background processing jobs with live logs via{" "}
                <Text code>/api/jobs/&lt;id&gt;</Text>.
              </Paragraph>
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card style={{ borderRadius: 14 }}>
            <Space direction="vertical">
              <Title level={5} style={{ margin: 0 }}>
                RAG-Ready
              </Title>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Test retrieval quickly with <Text code>/api/rag/search</Text> and wire into your LLM
                of choice (OpenAI, watsonx.ai, etc.).
              </Paragraph>
            </Space>
          </Card>
        </Col>
      </Row>

      {/* QUICKSTART */}
      <Card id="quickstart" title="Quickstart" style={{ borderRadius: 14 }}>
        <Row gutter={[24, 24]}>
          <Col xs={24} md={12}>
            <Title level={5} style={{ marginTop: 0 }}>
              1) Install & Configure
            </Title>
            <CodeBlock language="bash" code={INSTALL_PY} />
            <Divider />
            <Title level={5}>.env (example)</Title>
            <CodeBlock language="ini" code={ENV_SAMPLE} />
          </Col>
          <Col xs={24} md={12}>
            <Title level={5} style={{ marginTop: 0 }}>
              2) Run Milvus
            </Title>
            <CodeBlock language="bash" code={DOCKER_UP} />
            <Divider />
            <Title level={5}>3) Start the Backend</Title>
            <CodeBlock language="bash" code={RUN_SERVER} />
            <Alert
              style={{ marginTop: 12, borderRadius: 10 }}
              type="info"
              showIcon
              message="Frontend build"
              description={
                <>
                  The UI is pre-served from <Text code>ui/static</Text>. If you change the frontend,
                  rebuild it:
                  <div style={{ marginTop: 8 }}>
                    <CodeBlock language="bash" code={BUILD_UI} />
                  </div>
                </>
              }
            />
          </Col>
        </Row>
      </Card>

      {/* USING THE WIZARD */}
      <Card title="Using the Create Collection Wizard" style={{ borderRadius: 14 }}>
        <Row gutter={[24, 24]}>
          <Col xs={24} md={12}>
            <Space direction="vertical" size="middle">
              <Title level={5} style={{ marginTop: 0 }}>
                Steps
              </Title>
              <ol style={{ paddingLeft: 18, marginBottom: 0 }}>
                <li>
                  <Text strong>Schema</Text> — Pick collection <Text code>name</Text>,{" "}
                  <Text code>dim</Text> (auto-adapts to model), metric & index type.
                </li>
                <li>
                  <Text strong>Data source</Text> — Choose <Text code>upload</Text>,{" "}
                  <Text code>local</Text>, <Text code>http</Text>, <Text code>s3</Text>, or{" "}
                  <Text code>ibm</Text>.
                </li>
                <li>
                  <Text strong>Ingest options</Text> — Select embedding model, chunking, OCR, and
                  dedupe.
                </li>
                <li>
                  <Text strong>Review & Create</Text> — Upload begins; you’ll see two progress bars:
                  <ul>
                    <li>
                      <Text code>Upload</Text> — bytes sent to the server (Axios{" "}
                      <Text code>onUploadProgress</Text>).
                    </li>
                    <li>
                      <Text code>Processing</Text> — ingest + index build via{" "}
                      <Text code>/api/jobs/&lt;id&gt;</Text> polling.
                    </li>
                  </ul>
                </li>
              </ol>
              <Alert
                type="success"
                showIcon
                message="Pro tip"
                description={
                  <>
                    The backend exposes <Text code>/api/rag/models</Text> so the UI can list models
                    and auto-set the right embedding dimension.
                  </>
                }
              />
            </Space>
          </Col>
          <Col xs={24} md={12}>
            <Title level={5} style={{ marginTop: 0 }}>
              Upload & Job Progress (frontend)
            </Title>
            <Tabs
              defaultActiveKey="upload"
              items={[
                {
                  key: "upload",
                  label: (
                    <span>
                      <UploadOutlined /> Axios upload
                    </span>
                  ),
                  children: <CodeBlock language="tsx" code={AXIOS_PROGRESS} />,
                },
                {
                  key: "jobs",
                  label: (
                    <span>
                      <PlayCircleOutlined /> Poll jobs
                    </span>
                  ),
                  children: <CodeBlock language="tsx" code={JOB_POLLING} />,
                },
                {
                  key: "curl",
                  label: "cURL upload",
                  children: <CodeBlock language="bash" code={CURL_UPLOAD} />,
                },
              ]}
            />
          </Col>
        </Row>
      </Card>

      {/* ADMIN API */}
      <Card
        title="Insert & Search (via Admin API)"
        extra={<Text type="secondary">POST /api/rag/insert · POST /api/rag/search</Text>}
        style={{ borderRadius: 14 }}
      >
        <Tabs
          defaultActiveKey="python"
          items={[
            {
              key: "python",
              label: "Python",
              children: <CodeBlock language="python" code={PY_ADMIN} />,
            },
            {
              key: "javascript",
              label: "JavaScript",
              children: <CodeBlock language="javascript" code={JS_ADMIN} />,
            },
            {
              key: "curl",
              label: "cURL",
              children: <CodeBlock language="bash" code={CURL_ADMIN} />,
            },
          ]}
        />
      </Card>

      {/* SDK */}
      <Card
        title="Direct PyMilvus Search (SDK)"
        extra={<Text type="secondary">No HTTP — connect to Milvus directly</Text>}
        style={{ borderRadius: 14 }}
      >
        <CodeBlock language="python" code={PY_PYMILVUS} />
      </Card>

      {/* LLM */}
      <Card title="RAG Generation Examples" style={{ borderRadius: 14 }}>
        <Tabs
          defaultActiveKey="openai"
          items={[
            {
              key: "openai",
              label: "OpenAI (Python)",
              children: <CodeBlock language="python" code={PY_OPENAI} />,
            },
            {
              key: "watsonx",
              label: "IBM watsonx.ai (Python)",
              children: <CodeBlock language="python" code={PY_WATSONX} />,
            },
          ]}
        />
        <Divider />
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Tip: store <Text code>title/url/meta</Text> per chunk so answers include clickable
          references. For IVF, tune <Text code>nlist</Text> (index-time) and{" "}
          <Text code>nprobe</Text> (search-time). For HNSW, tune <Text code>M</Text>,{" "}
          <Text code>efConstruction</Text>, and search <Text code>ef</Text>.
        </Paragraph>
      </Card>

      {/* ENDPOINT REFERENCE */}
      <Card title="API Reference (quick)" style={{ borderRadius: 14 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                <Text code>GET /api/status</Text> — health & collections
              </li>
              <li>
                <Text code>GET /api/collections</Text> — list
              </li>
              <li>
                <Text code>POST /api/collections</Text> — create (JSON or form)
              </li>
              <li>
                <Text code>DELETE /api/collections/:name</Text> — drop
              </li>
              <li>
                <Text code>POST /api/rag/insert</Text> — demo inserts
              </li>
              <li>
                <Text code>POST /api/rag/search</Text> — semantic search
              </li>
            </ul>
          </Col>
          <Col xs={24} md={12}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                <Text code>POST /api/ingest/upload</Text> — multipart upload → background job
              </li>
              <li>
                <Text code>GET /api/jobs</Text> — list jobs
              </li>
              <li>
                <Text code>GET /api/jobs/:id</Text> — job status + logs tail
              </li>
              <li>
                <Text code>POST /api/sync</Text> — server-side ingest (local only by default)
              </li>
              <li>
                <Text code>GET /api/rag/models</Text> — embedding model catalog (+ dims)
              </li>
            </ul>
          </Col>
        </Row>
        <Divider />
        <Alert
          type="warning"
          showIcon
          message="Security"
          description={
            <>
              Set <Text code>ADMIN_TOKEN</Text> to require <Text code>X-Admin-Token</Text> for
              sensitive endpoints. Control remote access with{" "}
              <Text code>ALLOW_REMOTE_UPLOAD</Text> and <Text code>ALLOW_REMOTE_SYNC</Text>.
            </>
          }
          style={{ borderRadius: 10 }}
        />
      </Card>

      {/* TROUBLESHOOTING */}
      <Card title="Troubleshooting" style={{ borderRadius: 14 }}>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="error"
            showIcon
            message='422 on POST /api/collections'
            description={
              <>
                The server now accepts JSON <i>or</i> form bodies. Ensure your request sends
                <Text code>name</Text>, <Text code>dim</Text> (or <Text code>model</Text> to infer
                dims), <Text code>metric</Text>, <Text code>index_type</Text>, and{" "}
                <Text code>nlist</Text> (for IVF).
              </>
            }
            style={{ borderRadius: 10 }}
          />
          <Alert
            type="warning"
            showIcon
            message='RuntimeError: "python-multipart" required'
            description={
              <>
                Install it: <Text code>pip install python-multipart</Text>. This is needed for{" "}
                <Text code>UploadFile</Text> and multipart forms.
              </>
            }
            style={{ borderRadius: 10 }}
          />
          <Alert
            type="info"
            showIcon
            message="Milvus not reachable"
            description={
              <>
                Confirm <Text code>MILVUS_HOST</Text>/<Text code>MILVUS_PORT</Text>, and that{" "}
                <Text code>docker compose up</Text> reports healthy. Check{" "}
                <Text code>http://127.0.0.1:9091/healthz</Text>.
              </>
            }
            style={{ borderRadius: 10 }}
          />
        </Space>
      </Card>

      {/* FOOTER / CTA */}
      <Card
        styles={{ body: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } }}
        style={{
          borderRadius: 14,
          background:
            "linear-gradient(90deg, rgba(37,99,235,.08), rgba(99,102,241,.08))",
        }}
      >
        <Space direction="vertical" size={4}>
          <Title level={5} style={{ margin: 0 }}>
            Enjoying Milvus Admin UI?
          </Title>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            Built by <a href="https://ruslanmv.com" target="_blank" rel="noreferrer">Ruslan Magana Vsevolodovna</a>.
            If this saved you time, please consider giving it a ⭐ on GitHub!
          </Paragraph>
        </Space>
        <Space wrap>
          <Button
            type="primary"
            icon={<StarFilled />}
            href="https://github.com/ruslanmv/milvus-admin-ui"
            target="_blank"
            rel="noreferrer"
          >
            Star github.com/ruslanmv/milvus-admin-ui
          </Button>
          <Button
            icon={<GithubOutlined />}
            href="https://github.com/ruslanmv/milvus-admin-ui"
            target="_blank"
            rel="noreferrer"
          >
            View repository
          </Button>
          <Button
            icon={<HeartFilled style={{ color: "#ef4444" }} />}
            href="https://ruslanmv.com"
            target="_blank"
            rel="noreferrer"
          >
            ruslanmv.com
          </Button>
        </Space>
      </Card>
    </Space>
  );
}
