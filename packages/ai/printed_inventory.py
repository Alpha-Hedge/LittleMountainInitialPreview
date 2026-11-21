"""Reconcile recognizable native PDF callouts with the vision inventory."""

import hashlib
import re
from dataclasses import dataclass

from .schemas import EngineeringAST, EngineeringPart, Evidence, Outline


PRINTED_INVENTORY_VERSION = 4
SIZE = r'\d+(?:\s*[- ]\s*\d+/\d+|/\d+|\.\d+)?\s*(?:"|″|in\b|mm\b)'
DRAINAGE = re.compile(
    rf'(?<!\w)(?:{SIZE}\s+)?(?:STAINLESS\s+STEEL|GALVANIZED\s+STEEL|COPPER|ALUM(?:INUM|INIUM)|STEEL)\s+'
    r'(?:HALF[ -]ROUND\s+|BOX\s+|ROUND\s+|PIPE\s*\(\s*)?(?:GUTTER|DOWN\s*(?:SPOUT|SOUT))\b',
    re.I,
)
SECTION = re.compile(
    r"(?<![\w-])(?:HSS\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:/\d+|\.\d+)?|"
    r"(?:MC|C|W)\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?)(?![\w/.])",
    re.I,
)
NAMED_COMPONENT = re.compile(
    rf"(?<!\w)(?:{SIZE}\s+)?(?:"
    r"(?:MAINE\s+)?DECK\s+BRACKETS?|(?:MOUNTING|SUPPORT|WALL|CORNER)\s+(?:BRACKETS?|CLIPS?)|"
    r"(?:SHEET\s+METAL|METAL|STEEL|ALUM(?:INUM|INIUM))\s+FURRING\s+(?:STRIPS?|CHANNELS?)|"
    r"LIGHTING\s+FIXTURES?|(?:COPPER|ALUM(?:INUM|INIUM)|STEEL)\s+DRIP(?:\s+EDGE)?|"
    r"EPDM\s+EXTENSION|(?:ANCHOR|EXPANSION)\s+BOLTS?|WELD\s+STUDS?)\b",
    re.I,
)
MATERIALS = ("stainless steel", "galvanized steel", "copper", "aluminum", "aluminium", "steel")


def normalized(text):
    return re.sub(r"\s+", " ", text.casefold().replace("″", '"').replace("×", "x")).strip()


def compact(text):
    return re.sub(r"[^a-z0-9./]+", "", normalized(text).replace("downsout", "downspout"))


@dataclass(frozen=True)
class Candidate:
    page: int
    excerpt: str
    label: str
    form: str
    key: str
    material: str | None = None


def printed_candidates(page_text):
    for page, raw in sorted(page_text.items()):
        # Text runs can split a single callout across two lines.
        text = " ".join(raw.split())
        for match in SECTION.finditer(text):
            excerpt = match.group()
            code = compact(excerpt)
            form = "tube" if code.startswith("hss") else "beam" if code.startswith("w") else "channel"
            yield Candidate(page, excerpt, excerpt, form, code)
        for match in DRAINAGE.finditer(text):
            excerpt = match.group()
            words = normalized(excerpt)
            if words.startswith(tuple("0123456789")):
                nominal = next(re.finditer(SIZE, words, re.I)).group()
            else:
                nominal = ""
            material = next(item for item in MATERIALS if item in words)
            feature = "gutter" if "gutter" in words else "downspout"
            key = compact(excerpt)
            label = " ".join([nominal, material, "half-round " + feature if "half" in words else feature]).strip()
            yield Candidate(page, excerpt, label, "pipe" if "pipe" in words else "other", key, material)
        for match in NAMED_COMPONENT.finditer(text):
            prefix = text[max(0, match.start() - 20):match.start()]
            suffix = text[match.end():match.end() + 28]
            if re.search(r"\b(?:existing|remove)\s+$", prefix, re.I) or re.match(
                r"[\s,;(]*(?:by others|for reference|to be removed)\b", suffix, re.I
            ):
                continue
            excerpt = match.group()
            key = compact(excerpt)
            yield Candidate(page, excerpt, excerpt, "channel" if "furringchannel" in key else "other", key)


def matching_part(ast, candidate):
    for part in ast.parts:
        names = (part.section_designation or "", part.description or "")
        if any(candidate.key == compact(name) for name in names):
            return part
        described = normalized(" ".join((*names, part.material_family or "")))
        if candidate.material:
            component = "gutter" if "gutter" in candidate.key else "downspout"
            described = described.replace("downsout", "downspout")
            if candidate.material not in described or component not in described:
                continue
        for ev in part.evidence:
            # A native token inside the cited source is useful only with a component field.
            if (ev.source == "pdf" and set(ev.fields) & {"description", "section_designation"}
                    and compact(candidate.excerpt) in compact(ev.excerpt)):
                return part
    return None


def reconcile_inventory(ast: EngineeringAST, page_text, checked_parts=(), *, prior_callouts=()):
    """Keep recovered components as scope candidates. Their order quantities remain open."""
    candidates = list(printed_candidates(page_text))
    for item in checked_parts:
        text = page_text.get(item.page, "")
        label = " ".join(item.label.split())
        excerpt = " ".join(item.evidence.split())
        normalized_label = normalized(label)
        if (5 <= len(label) <= 120 and len(excerpt) <= 400
                and re.search(r"(?<!\w)" + re.escape(normalized_label) + r"(?!\w)", normalized(excerpt))
                and normalized(excerpt) in normalized(text)
                and not re.search(r"\b(?:existing|by others|for reference|remove)\b", excerpt, re.I)):
            candidates.append(Candidate(item.page, excerpt, label, item.stock_form, compact(label)))

    ledger = list(prior_callouts)
    seen = {compact(row[field]) for row in ledger for field in ("label", "evidence")}
    for candidate in candidates:
        if candidate.key in seen:
            continue
        seen.add(candidate.key)
        part = matching_part(ast, candidate)
        if part is not None:
            status = "captured"
        elif len(ast.parts) < 50:
            key = "SRC-" + hashlib.sha256(candidate.key.encode()).hexdigest()[:12]
            fields = ["description", "section_designation", "stock_form"]
            if candidate.material:
                fields.append("material_family")
            part = EngineeringPart(
                part_id=key, description=candidate.label, stock_form=candidate.form,
                section_designation=candidate.excerpt, material_family=candidate.material,
                confidence=0.9, outline=Outline(kind="unknown", confidence=0.9),
                evidence=[Evidence(source="pdf", page=candidate.page, excerpt=candidate.excerpt, fields=fields)],
            )
            ast.parts.append(part)
            status = "recovered"
        else:
            status = "review"
        ledger.append({"page": candidate.page, "label": candidate.label, "evidence": candidate.excerpt,
                       "status": status, "part_id": part.part_id if part else None})
    return ledger
