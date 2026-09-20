"""陶瓷窑车层架载荷计算引擎。

模型（自下而上录入）：
  层 i 的棚板由“本层立柱”向下支撑，立柱的脚落在层 i-1 的棚板（或第 0 层时
  窑车台面）上。层 i+1 立柱的脚落在层 i 的棚板上，其载荷经支点压入本层棚板，
  再由本层立柱平均分摊后继续向下传递。

判定：
  * 悬空    —— 立柱的脚不在它应落的下层棚板（或台面）范围内，或柱头顶出
                它所承托的棚板范围；悬空柱不参与分摊，载荷转移给其余有效柱。
  * 落点重叠 —— 同一层两根及以上立柱的脚坐标完全相同（距离小于容差）。
  * 超载    —— 柱所分摊到的载荷（反力）超过其容量。
"""

from __future__ import annotations

import math
from typing import Any

EPS = 1e-9


def _num(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        result = float(value)
        if math.isnan(result) or math.isinf(result):
            raise ValueError
        return result
    except (TypeError, ValueError):
        raise


def point_in_rect(px: float, py: float, rect: dict) -> bool:
    """点是否落在矩形内（以左下角 (x, y) 为原点，含边界）。"""
    return (
        rect["x"] - EPS <= px <= rect["x"] + rect["width"] + EPS
        and rect["y"] - EPS <= py <= rect["y"] + rect["height"] + EPS
    )


def rect_of(layer: dict) -> dict:
    return {
        "x": layer["x"],
        "y": layer["y"],
        "width": layer["width"],
        "height": layer["height"],
    }


def col_name(layer_index: int, col_index: int) -> str:
    return f"L{layer_index + 1}C{col_index + 1}"


def layer_name(layer_index: int, layer: dict) -> str:
    label = layer.get("name") or ""
    return label.strip() if isinstance(label, str) and label.strip() else f"第{layer_index + 1}层"


def validate(data: dict) -> list[str]:
    """返回错误信息列表；为空表示数据合法。"""
    errors: list[str] = []

    if not isinstance(data, dict):
        return ["数据必须是 JSON 对象"]

    deck = data.get("deck") or {}
    for key in ("width", "depth"):
        try:
            value = _num(deck.get(key))
            if value <= 0:
                errors.append(f"窑车台面 {key}（{value}）必须为正数")
        except (TypeError, ValueError):
            errors.append(f"窑车台面 {key} 不是有效数字")

    try:
        tol = _num(data.get("overlap_tolerance", 0.0))
        if tol < 0:
            errors.append("重叠容差不能为负数")
    except (TypeError, ValueError):
        errors.append("重叠容差不是有效数字")

    layers = data.get("layers")
    if not isinstance(layers, list) or not layers:
        errors.append("至少需要一层棚板")
        layers = []

    for i, layer in enumerate(layers):
        if not isinstance(layer, dict):
            errors.append(f"第{i + 1}层：数据格式错误")
            continue
        tag = f"第{i + 1}层"

        for key in ("width", "height"):
            try:
                value = _num(layer.get(key))
                if value <= 0:
                    errors.append(f"{tag} 棚板{key}（{value}）必须为正数")
            except (TypeError, ValueError):
                errors.append(f"{tag} 棚板{key} 不是有效数字")

        for key in ("x", "y"):
            try:
                _num(layer.get(key))
            except (TypeError, ValueError):
                errors.append(f"{tag} 棚板位置 {key} 不是有效数字")

        for key, label in (("shelf_weight", "棚板自重"), ("ware_weight", "坯件重量")):
            try:
                value = _num(layer.get(key, 0))
                if value < 0:
                    errors.append(f"{tag} {label}（{value}）不能为负数")
            except (TypeError, ValueError):
                errors.append(f"{tag} {label} 不是有效数字")

        columns = layer.get("columns")
        if columns is None:
            columns = []
        if not isinstance(columns, list):
            errors.append(f"{tag}：立柱数据格式错误")
            continue

        for j, col in enumerate(columns):
            if not isinstance(col, dict):
                errors.append(f"{tag} 立柱{j + 1}：数据格式错误")
                continue
            ctag = f"{tag} 立柱{j + 1}"
            for key in ("x", "y"):
                try:
                    _num(col.get(key))
                except (TypeError, ValueError):
                    errors.append(f"{ctag} 坐标 {key} 不是有效数字")
            try:
                cap = _num(col.get("capacity"))
                if cap <= 0:
                    errors.append(f"{ctag} 容量（{cap}）必须为正数")
            except (TypeError, ValueError):
                errors.append(f"{ctag} 容量不是有效数字")

    return errors


def normalize(data: dict) -> dict:
    deck = data.get("deck") or {}
    layers_in = data.get("layers") or []

    layers = []
    for i, raw in enumerate(layers_in):
        columns = []
        for j, c in enumerate(raw.get("columns") or []):
            columns.append(
                {
                    "id": col_name(i, j),
                    "x": _num(c.get("x")),
                    "y": _num(c.get("y")),
                    "capacity": _num(c.get("capacity")),
                }
            )
        layers.append(
            {
                "name": raw.get("name") or "",
                "x": _num(raw.get("x")),
                "y": _num(raw.get("y")),
                "width": _num(raw.get("width")),
                "height": _num(raw.get("height")),
                "shelf_weight": _num(raw.get("shelf_weight", 0)),
                "ware_weight": _num(raw.get("ware_weight", 0)),
                "columns": columns,
            }
        )

    return {
        "deck": {"width": _num(deck.get("width")), "depth": _num(deck.get("depth"))},
        "overlap_tolerance": _num(data.get("overlap_tolerance", 0.0)),
        "layers": layers,
    }


def compute(data: dict) -> dict:
    """计算整架载荷，返回带状态与载荷来源的结果。"""
    errors = validate(data)
    if errors:
        return {"ok": False, "errors": errors}

    model = normalize(data)
    layers = model["layers"]
    n = len(layers)
    deck = model["deck"]
    tol = model["overlap_tolerance"]

    # 预分配结果，自上而下计算：处理第 i 层时，第 i+1 层立柱的反力已经得出。
    results: list[dict | None] = [None] * n

    # 第 i 层立柱的头顶着第 i 层棚板，脚落在第 i-1 层棚板/台面上；
    # 第 i+1 层立柱的脚压在第 i 层棚板上，其反力即本层收到的上载。
    for i in range(n - 1, -1, -1):
        layer = layers[i]
        rect = rect_of(layer)
        columns = layer["columns"]

        # ---- 上层（i+1）立柱落在本层棚板上的载荷（已在处理 i+1 时算出）----
        incoming = 0.0
        incoming_sources: list[dict] = []
        if i + 1 < n:
            above = results[i + 1]
            for col, cres in zip(layers[i + 1]["columns"], above["columns"]):
                if not cres.get("supported", False):
                    continue
                if not point_in_rect(col["x"], col["y"], rect):
                    # 几何上柱脚应在第 i 层棚板内；不在则它在上面一层已被标记悬空。
                    continue
                incoming += cres["load"]
                incoming_sources.append(
                    {
                        "kind": "column",
                        "from_layer_index": i + 1,
                        "from_column_id": col["id"],
                        "gross": cres["load"],
                    }
                )

        gross = layer["shelf_weight"] + layer["ware_weight"] + incoming
        gross_sources = (
            [
                {
                    "kind": "shelf",
                    "from_layer_index": i,
                    "label": f"{layer_name(i, layer)} 棚板自重",
                    "gross": layer["shelf_weight"],
                },
                {
                    "kind": "ware",
                    "from_layer_index": i,
                    "label": f"{layer_name(i, layer)} 坯件重量",
                    "gross": layer["ware_weight"],
                },
            ]
            + [
                {
                    "kind": "column",
                    "from_layer_index": s["from_layer_index"],
                    "from_column_id": s["from_column_id"],
                    "label": f"上层立柱 {s['from_column_id']} 压入",
                    "gross": s["gross"],
                }
                for s in incoming_sources
            ]
        )

        # ---- 落点重叠（按脚坐标分组）----
        overlap_groups: list[list[int]] = []
        for j in range(len(columns)):
            group = [j]
            for k in range(j + 1, len(columns)):
                a, b = columns[j], columns[k]
                if math.hypot(a["x"] - b["x"], a["y"] - b["y"]) <= tol + EPS:
                    group.append(k)
            if len(group) > 1:
                overlap_groups.append(group)

        overlap_set = {j for group in overlap_groups for j in group}
        overlap_pairs = [
            [col_name(i, j) for j in group] for group in overlap_groups
        ]

        # ---- 几何判定：脚是否落在下层棚板/台面；头是否顶在本层棚板内 ----
        col_results = []
        valid_idx: list[int] = []
        for j, col in enumerate(columns):
            if i == 0:
                foot_rect = {
                    "x": 0.0,
                    "y": 0.0,
                    "width": deck["width"],
                    "height": deck["depth"],
                }
            else:
                foot_rect = rect_of(layers[i - 1])
            foot_on = point_in_rect(col["x"], col["y"], foot_rect)
            head_under = point_in_rect(col["x"], col["y"], rect)
            supported = foot_on and head_under
            if supported:
                valid_idx.append(j)

            if not foot_on:
                landing = "悬空"
                landing_detail = (
                    "柱脚落在窑车台面之外"
                    if i == 0
                    else f"柱脚未落在下层（{layer_name(i - 1, layers[i - 1])}）棚板范围内"
                )
            elif not head_under:
                landing = "悬空"
                landing_detail = f"柱头顶出所承托的{layer_name(i, layer)}棚板范围"
            else:
                landing = "ok"
                landing_detail = (
                    "落在窑车台面"
                    if i == 0
                    else f"落在下层（{layer_name(i - 1, layers[i - 1])}）棚板"
                )

            col_results.append(
                {
                    "id": col["id"],
                    "layer_index": i,
                    "column_index": j,
                    "x": col["x"],
                    "y": col["y"],
                    "capacity": col["capacity"],
                    "foot_on": foot_on,
                    "head_under": head_under,
                    "supported": supported,
                    "landing": landing,
                    "landing_detail": landing_detail,
                    "load": 0.0,
                    "overloaded": False,
                    "overlap": j in overlap_set,
                    "sources": [],
                }
            )

        # ---- 反力分摊（仅有效柱平均承担整层毛重）----
        n_valid = len(valid_idx)
        share = gross / n_valid if n_valid else 0.0
        for j, cres in enumerate(col_results):
            if n_valid and j in valid_idx:
                cres["load"] = share
                cres["sources"] = [
                    {
                        "kind": s["kind"],
                        "label": s["label"],
                        "from_layer_index": s.get("from_layer_index"),
                        "from_column_id": s.get("from_column_id"),
                        "gross": s["gross"],
                        "share": s["gross"] / n_valid,
                    }
                    for s in gross_sources
                ]
                cres["overloaded"] = share > cres["capacity"] + EPS

        supported_count = n_valid
        unsupported = n_valid == 0
        status = "unsupported" if unsupported else (
            "overloaded" if any(c["overloaded"] for c in col_results) else "ok"
        )
        if not unsupported and any(not c["supported"] for c in col_results):
            if status == "ok":
                status = "floating"

        warnings: list[dict] = []
        for group in overlap_groups:
            ids = [col_name(i, j) for j in group]
            at = columns[group[0]]
            warnings.append(
                {
                    "type": "overlap",
                    "layer_index": i,
                    "column_ids": ids,
                    "x": at["x"],
                    "y": at["y"],
                    "message": f"{'、'.join(ids)} 落点重叠（坐标 {at['x']:g}, {at['y']:g}）",
                }
            )
        for cres in col_results:
            if not cres["supported"]:
                warnings.append(
                    {
                        "type": "floating",
                        "layer_index": i,
                        "column_ids": [cres["id"]],
                        "x": cres["x"],
                        "y": cres["y"],
                        "message": f"{cres['id']} 悬空：{cres['landing_detail']}",
                    }
                )
        for cres in col_results:
            if cres["overloaded"]:
                warnings.append(
                    {
                        "type": "overload",
                        "layer_index": i,
                        "column_ids": [cres["id"]],
                        "x": cres["x"],
                        "y": cres["y"],
                        "message": (
                            f"{cres['id']} 超载：载荷 {share:g} kg "
                            f"> 容量 {cres['capacity']:g} kg"
                        ),
                    }
                )
        if unsupported:
            warnings.append(
                {
                    "type": "unsupported",
                    "layer_index": i,
                    "column_ids": [c["id"] for c in col_results],
                    "message": f"{layer_name(i, layer)} 没有任何有效支撑立柱，整层载荷无法下传",
                }
            )

        results[i] = {
            "layer_index": i,
            "name": layer_name(i, layer),
            "x": layer["x"],
            "y": layer["y"],
            "width": layer["width"],
            "height": layer["height"],
            "shelf_weight": layer["shelf_weight"],
            "ware_weight": layer["ware_weight"],
            "incoming": incoming,
            "gross": gross,
            "share": share,
            "supported_count": supported_count,
            "column_count": len(columns),
            "status": status,
            "warnings": warnings,
            "columns": col_results,
        }

    # results[i] 为自下而上第 i 层；处理顺序自上而下，故引用 results[i+1] 时已就绪。
    global_warnings: list[dict] = []
    for r in results:
        global_warnings.extend(r["warnings"])

    return {
        "ok": True,
        "errors": [],
        "deck": deck,
        "overlap_tolerance": tol,
        "layers": results,
        "warnings": global_warnings,
    }
