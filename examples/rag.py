#!/usr/bin/env python3
import os
import argparse
import logging
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer
from pymilvus import connections, utility, FieldSchema, CollectionSchema, DataType, Collection

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("mui.examples.rag")

def _bool_env(name: str, default: bool=False) -> bool:
    v = os.getenv(name)
    return default if v is None else str(v).lower() in {"1","true","yes","y"}

def connect_from_env():
    uri = os.getenv("MILVUS_URI")
    host = os.getenv("MILVUS_HOST", "127.0.0.1")
    port = os.getenv("MILVUS_PORT", "19530")
    secure = _bool_env("MILVUS_SECURE", False)
    token = os.getenv("MILVUS_TOKEN")
    user = os.getenv("MILVUS_USER")
    password = os.getenv("MILVUS_PASSWORD")
    db_name = os.getenv("MILVUS_DB")
    timeout = int(os.getenv("MILVUS_TIMEOUT", "60"))
    kwargs = {"timeout": timeout}
    if uri:
        kwargs["uri"] = uri
    else:
        kwargs.update({"host": host, "port": port})
        if secure:
            kwargs["secure"] = True
    if token:
        kwargs["token"] = token
    elif user and password:
        kwargs["user"] = user; kwargs["password"] = password
    if db_name:
        kwargs["db_name"] = db_name
    log.info("Connecting to Milvus: %s", kwargs.get("uri") or f"{kwargs.get('host')}:{kwargs.get('port')}")
    connections.connect(alias="default", **kwargs)

def ensure_collection(name: str, dim: int, metric="IP", index_type="IVF_FLAT", nlist=1024) -> Collection:
    if utility.has_collection(name):
        c = Collection(name)
    else:
        fields = [
            FieldSchema(name="doc_id", dtype=DataType.VARCHAR, is_primary=True, auto_id=False, max_length=64),
            FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=2048),
            FieldSchema(name="vec", dtype=DataType.FLOAT_VECTOR, dim=dim),
        ]
        schema = CollectionSchema(fields=fields, description="MUI RAG demo collection")
        c = Collection(name, schema)
        c.create_index("vec", {"index_type": index_type, "metric_type": metric, "params": {"nlist": nlist}})
    try: c.load()
    except Exception: pass
    return c

def embed(model: SentenceTransformer, texts):
    return model.encode(texts, normalize_embeddings=True).tolist()

def main():
    load_dotenv(override=False)
    p = argparse.ArgumentParser()
    p.add_argument("--collection", default=os.getenv("RAG_COLLECTION","mui_demo"))
    p.add_argument("--model", default=os.getenv("RAG_MODEL","sentence-transformers/paraphrase-MiniLM-L6-v2"))
    p.add_argument("--dim", type=int, default=int(os.getenv("EMBED_DIM","384")))
    p.add_argument("--query", default="Where is the incident root-cause template?")
    p.add_argument("--reset", action="store_true")
    a = p.parse_args()

    connect_from_env()
    if a.reset and utility.has_collection(a.collection):
        utility.drop_collection(a.collection)
    model = SentenceTransformer(a.model)
    c = ensure_collection(a.collection, a.dim)
    if c.num_entities == 0:
        docs = [("1","How do I reset my LDAP password?"), ("2","Postmortem template for production incidents.")]
        vecs = embed(model, [d[1] for d in docs])
        c.insert([[d[0] for d in docs],[d[1] for d in docs],vecs]); c.load()
    qv = embed(model, [a.query])
    res = c.search(qv, "vec", param={"nprobe":10}, limit=3, output_fields=["doc_id","text"])
    for hits in res:
        for h in hits:
            print(f"{getattr(h,'score',0.0):.4f}\t{h.entity.get('doc_id')}\t{h.entity.get('text')}")
    log.info("Done.")

if __name__ == "__main__":
    main()
