"""#63: LoRA SFT of a small model on verified OpenArc traces (rejection sampling: only `verified` lines).

usage: HSA_OVERRIDE_GFX_VERSION=11.0.0 .venv/bin/python train_lora.py --traces traces.jsonl --tasks tasks.jsonl --base <hf dir> --out <adapter dir>
       [--exclude ids.txt] [--epochs 2] [--max-len 4096] [--dry]
Each example = the prompt messages exactly as the compiler sent them + the raw verified reply, loss on the reply only.
Dedup: one example per (region id, reply). Any task id in --exclude (dev/test/evolve-multi) is dropped as a guard.
"""
import argparse, json, random, sys

ap = argparse.ArgumentParser()
ap.add_argument("--traces", required=True)
ap.add_argument("--base", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--exclude")
ap.add_argument("--tasks", help="run.mjs tasks.jsonl: keep only traces of tasks whose hidden tests all pass (heldOut.allPass)")
ap.add_argument("--epochs", type=float, default=2)
ap.add_argument("--max-len", type=int, default=4096)
ap.add_argument("--rank", type=int, default=16)
ap.add_argument("--lr", type=float, default=2e-4)
ap.add_argument("--dry", action="store_true")
ap.add_argument("--max-steps", type=int, default=-1)
a = ap.parse_args()

exclude = set(open(a.exclude).read().split()) if a.exclude else set()
good = None
if a.tasks:  # a verified body can still be wrong on thin examples (1 per MBPP task): the hidden tests decide
    good = {(j["exercise"], j.get("seed", 1)) for j in map(json.loads, open(a.tasks)) if (j.get("heldOut") or {}).get("allPass")}
seen, rows, dropped = set(), [], 0
for line in open(a.traces):
    t = json.loads(line)
    if t.get("outcome") != "verified" or not t.get("raw"):
        continue
    task = t.get("task") or t.get("id")
    if good is not None and (task, t.get("seed", 1)) not in good:
        continue
    if task in exclude or t.get("id") in exclude:
        dropped += 1
        continue
    key = (t["id"], t["raw"])
    if key in seen:
        continue
    seen.add(key)
    rows.append({"prompt": t["messages"], "completion": [{"role": "assistant", "content": t["raw"]}]})  # prompt-completion: loss on the reply only
print(f"examples {len(rows)} (excluded {dropped})", file=sys.stderr)
if not rows:
    sys.exit("no verified traces")

import torch
from datasets import Dataset
from peft import LoraConfig
from transformers import AutoTokenizer
from trl import SFTConfig, SFTTrainer

tok = AutoTokenizer.from_pretrained(a.base)
lens = [len(tok(tok.apply_chat_template(r["prompt"] + r["completion"], tokenize=False)).input_ids) for r in rows]
keep = [r for r, n in zip(rows, lens) if n <= a.max_len]
print(f"kept {len(keep)} <= {a.max_len} tokens; max {max(lens)}, mean {sum(lens) // len(lens)}", file=sys.stderr)
if a.dry:
    sys.exit(0)
random.Random(0).shuffle(keep)

cfg = SFTConfig(
    output_dir=a.out,
    num_train_epochs=a.epochs,
    max_steps=a.max_steps,
    per_device_train_batch_size=1,
    gradient_accumulation_steps=8,
    learning_rate=a.lr,
    lr_scheduler_type="cosine",
    warmup_steps=3,
    bf16=True,
    gradient_checkpointing=True,
    max_length=a.max_len,
    logging_steps=5,
    save_strategy="epoch",
    report_to=[],
    model_init_kwargs={"dtype": torch.bfloat16},
)
peft_cfg = LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
tr = SFTTrainer(model=a.base, args=cfg, train_dataset=Dataset.from_list(keep), processing_class=tok, peft_config=peft_cfg)
tr.train()
tr.save_model(a.out)
print("saved", a.out, file=sys.stderr)
