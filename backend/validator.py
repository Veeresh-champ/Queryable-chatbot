import re

from backend.guardrails import is_pii_field
from backend.schema_discovery import get_schema


ALLOWED_OPERATIONS = {"find", "count", "distinct", "aggregate"}

ALLOWED_FILTER_OPERATORS = {
    "$eq", "$ne", "$gt", "$gte", "$lt", "$lte",
    "$in", "$nin", "$regex", "$options", "$exists",
    "$and", "$or", "$nor", "$not", "$expr", "$size", "$type",
}

ALLOWED_PIPELINE_STAGES = {
    "$match", "$group", "$sort", "$limit", "$skip",
    "$project", "$unwind", "$facet", "$addFields", "$lookup", "$count",
    # Read-only reshaping and bucketing stages ($out, $merge, $function and
    # $accumulator stay blocked: they write data or run code).
    "$set", "$unset", "$sortByCount", "$bucket", "$bucketAuto", "$replaceRoot",
    # Combine datasets of the same kind (e.g. one company sheet per industry).
    # The target must be a readable collection in the current scope.
    "$unionWith",
}

ALLOWED_GROUP_OPERATORS = {
    "$sum", "$avg", "$min", "$max", "$first",
    "$last", "$push", "$addToSet", "$count",
    "$stdDevPop", "$stdDevSamp", "$median", "$percentile",
}

ALLOWED_EXPRESSION_OPERATORS = {
    "$add", "$subtract", "$multiply", "$divide",
    "$ifNull", "$cond", "$toDouble", "$toInt",
    "$round", "$abs", "$concat", "$toString", "$arrayElemAt",
    # Read-only expressions overview and statistics questions need.
    "$size", "$mod", "$floor", "$ceil", "$trunc", "$sqrt", "$pow", "$log10", "$ln", "$exp",
    "$toLower", "$toUpper", "$trim", "$split", "$substrCP", "$strLenCP", "$toLong", "$toDecimal", "$toBool",
    "$year", "$month", "$dayOfMonth", "$dateToString", "$dateFromString", "$toDate",
    "$switch", "$isArray", "$setUnion", "$concatArrays", "$slice", "$filter", "$map", "$in",
    "$cmp", "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$and", "$or", "$not", "$isNumber",
}


# Limits that keep generated queries cheap (see the security audit, L-4).
MAX_PIPELINE_STAGES = 30
MAX_JOINS = 5            # $lookup + $unionWith stages, nested ones included
MAX_REGEX_CHARS = 200
# A quantified group that is itself quantified, e.g. (a+)+ or (\w*)*: the
# classic catastrophic-backtracking shape.
NESTED_QUANTIFIER = re.compile(r"\([^)]*[+*}][^)]*\)\s*[+*{]")


def references_pii(value):
    """True when an aggregation value reads a PII field ("$phone", "$contact.email").

    Field names can be renamed inside a pipeline ({"p": "$phone"}), which
    would hide them from the name-based masking in ``guardrails.redact_pii``.
    Generated queries may filter on such fields but never copy them out.
    """

    if isinstance(value, str):
        if value.startswith("$$"):
            # Variables are field paths too: "$$ROOT.phone", "$$CURRENT.email",
            # "$$c.phone" inside $map/$filter. Check the path after the name.
            _, _, path = value[2:].partition(".")
            return bool(path) and is_pii_field(path)
        return value.startswith("$") and is_pii_field(value[1:])
    if isinstance(value, list):
        return any(references_pii(item) for item in value)
    if isinstance(value, dict):
        return any(references_pii(item) for item in value.values())
    return False


# Never allowed anywhere in a generated query, including inside $expr:
# server-side JavaScript and write stages.
FORBIDDEN_ANYWHERE = {"$function", "$accumulator", "$where", "$out", "$merge"}
JOIN_KEY_FIELDS = {"localField", "foreignField", "connectFromField", "connectToField"}


def unsafe_anywhere(value):
    """True when a filter or pipeline uses forbidden operators or touches PII.

    Generated queries may not filter, sort, group, join or project on a
    personal-data field: besides copying values out, filtering lets a caller
    recover them one character at a time (e.g. counting ``email ^a``).
    """

    if isinstance(value, list):
        return any(unsafe_anywhere(item) for item in value)
    if isinstance(value, str):
        return references_pii(value)
    if not isinstance(value, dict):
        return False
    for key, item in value.items():
        if not isinstance(key, str):
            return True
        if key in FORBIDDEN_ANYWHERE:
            return True
        if not key.startswith("$") and is_pii_field(key):
            return True
        if key in JOIN_KEY_FIELDS and isinstance(item, str) and is_pii_field(item):
            return True
        if unsafe_anywhere(item):
            return True
    return False


def safe_regex(pattern):
    return isinstance(pattern, str) and len(pattern) <= MAX_REGEX_CHARS and not NESTED_QUANTIFIER.search(pattern)


def _regexes(value):
    """Every $regex pattern anywhere inside a filter or pipeline."""

    if isinstance(value, list):
        for item in value:
            yield from _regexes(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key == "$regex":
                yield item
            elif key == "regex" and isinstance(item, str):  # $regexMatch style
                yield item
            else:
                yield from _regexes(item)


def _join_count(pipeline):
    count = 0
    for stage in pipeline if isinstance(pipeline, list) else []:
        if not isinstance(stage, dict):
            continue
        for name, body in stage.items():
            if name in {"$lookup", "$unionWith"}:
                count += 1
                if isinstance(body, dict):
                    count += _join_count(body.get("pipeline"))
            elif name == "$facet" and isinstance(body, dict):
                count += sum(_join_count(sub) for sub in body.values())
    return count


def get_available_schema():
    try:
        schema = get_schema()
        return schema if isinstance(schema, dict) else {}
    except Exception:
        return {}


def validate_collection(collection_name):
    return (
        isinstance(collection_name, str)
        and collection_name in get_available_schema()
    )


def validate_fields(collection_name, fields):
    schema = get_available_schema()

    if collection_name not in schema or not isinstance(fields, list):
        return False

    available_fields = schema[collection_name]

    return all(
        isinstance(field, str)
        and field != "_id"
        and field.split(".", 1)[0] in available_fields
        for field in fields
    )


def validate_filter_expression(expression, available_fields):
    if not isinstance(expression, dict):
        return False

    for key, value in expression.items():
        if not isinstance(key, str):
            return False

        if key in {"$and", "$or", "$nor"}:
            if not isinstance(value, list) or not value:
                return False

            if not all(
                validate_filter_expression(item, available_fields)
                for item in value
            ):
                return False

        elif key.startswith("$"):
            if key not in ALLOWED_FILTER_OPERATORS:
                return False

            if key == "$not":
                if not isinstance(value, dict):
                    return False

                if not validate_filter_expression(value, available_fields):
                    return False

        else:
            root_field = key.split(".", 1)[0]

            if root_field not in available_fields:
                return False

            if isinstance(value, dict):
                for operator in value:
                    if (
                        not isinstance(operator, str)
                        or operator not in ALLOWED_FILTER_OPERATORS
                    ):
                        return False

                if "$options" in value and "$regex" not in value:
                    return False

                if "$regex" in value and not isinstance(
                    value["$regex"], str
                ):
                    return False

                if "$options" in value and not isinstance(
                    value["$options"], str
                ):
                    return False

                if "$exists" in value and not isinstance(
                    value["$exists"], bool
                ):
                    return False

                for operator in ("$in", "$nin"):
                    if operator in value and not isinstance(
                        value[operator], list
                    ):
                        return False

    return True


def validate_filters(collection_name, filters):
    schema = get_available_schema()

    if collection_name not in schema or not isinstance(filters, dict):
        return False

    return validate_filter_expression(
        filters, set(schema[collection_name])
    )


def validate_operation(operation):
    return (
        isinstance(operation, str)
        and operation in ALLOWED_OPERATIONS
    )


def validate_pipeline_value(value):
    if isinstance(value, list):
        return all(validate_pipeline_value(item) for item in value)

    if not isinstance(value, dict):
        return True

    allowed_operators = (
        ALLOWED_FILTER_OPERATORS
        | ALLOWED_GROUP_OPERATORS
        | ALLOWED_EXPRESSION_OPERATORS
        | ALLOWED_PIPELINE_STAGES
        | {"$literal"}
    )

    for key, nested_value in value.items():
        if not isinstance(key, str):
            return False

        if key.startswith("$") and key not in allowed_operators:
            return False

        if not validate_pipeline_value(nested_value):
            return False

    return True


def validate_pipeline(pipeline):
    if not isinstance(pipeline, list) or not pipeline or len(pipeline) > MAX_PIPELINE_STAGES:
        return False

    schema = get_available_schema()

    for stage in pipeline:
        if not isinstance(stage, dict) or len(stage) != 1:
            return False

        stage_name = next(iter(stage))

        if stage_name not in ALLOWED_PIPELINE_STAGES:
            return False

        stage_value = stage[stage_name]

        if stage_name == "$facet":
            if not isinstance(stage_value, dict) or not stage_value:
                return False

            for nested_pipeline in stage_value.values():
                if not validate_pipeline(nested_pipeline):
                    return False

        elif stage_name == "$lookup":
            if not isinstance(stage_value, dict):
                return False

            if set(stage_value) - {"from", "localField", "foreignField", "pipeline", "as"}:
                return False

            foreign_collection = stage_value.get("from")
            output_field = stage_value.get("as")
            nested_pipeline = stage_value.get("pipeline")
            join_fields = [stage_value.get(k) for k in ("localField", "foreignField")]

            if foreign_collection not in schema:
                return False

            if (
                not isinstance(output_field, str)
                or not output_field
                or output_field.startswith("$")
            ):
                return False

            # Equality join (localField/foreignField), a sub-pipeline, or both.
            has_join = any(field is not None for field in join_fields)
            if has_join and not all(
                isinstance(field, str) and field and not field.startswith("$")
                for field in join_fields
            ):
                return False

            if nested_pipeline is None:
                if not has_join:
                    return False
            elif not validate_pipeline(nested_pipeline):
                return False

        elif stage_name == "$match":
            if not isinstance(stage_value, dict):
                return False

        elif stage_name == "$unionWith":
            if isinstance(stage_value, str):
                target, nested = stage_value, None
            elif isinstance(stage_value, dict) and not set(stage_value) - {"coll", "pipeline"}:
                target, nested = stage_value.get("coll"), stage_value.get("pipeline")
            else:
                return False
            if not isinstance(target, str) or target not in schema:
                return False
            if nested is not None and nested != [] and not validate_pipeline(nested):
                return False

        elif stage_name == "$group":
            if not isinstance(stage_value, dict) or "_id" not in stage_value:
                return False

            for field, expression in stage_value.items():
                if field == "_id":
                    continue

                if not isinstance(expression, dict) or len(expression) != 1:
                    return False

                operator = next(iter(expression))

                if operator not in (
                    ALLOWED_GROUP_OPERATORS
                    | ALLOWED_EXPRESSION_OPERATORS
                    | {"$literal"}
                ):
                    return False

        elif stage_name in {"$addFields", "$project"}:
            if not isinstance(stage_value, dict) or not stage_value:
                return False

        elif stage_name == "$sort":
            if not isinstance(stage_value, dict) or not stage_value:
                return False

            if not all(
                isinstance(direction, int)
                and not isinstance(direction, bool)
                and direction in (-1, 1)
                for direction in stage_value.values()
            ):
                return False

        elif stage_name in {"$limit", "$skip"}:
            if (
                not isinstance(stage_value, int)
                or isinstance(stage_value, bool)
                or stage_value < 0
            ):
                return False

            if stage_name == "$limit" and stage_value == 0:
                return False

        elif stage_name == "$count":
            if (
                not isinstance(stage_value, str)
                or not stage_value
                or stage_value.startswith("$")
                or "." in stage_value
            ):
                return False

        elif stage_name == "$unwind":
            if isinstance(stage_value, str):
                if not stage_value.startswith("$"):
                    return False

            elif isinstance(stage_value, dict):
                path = stage_value.get("path")

                if not isinstance(path, str) or not path.startswith("$"):
                    return False

                allowed_keys = {
                    "path",
                    "includeArrayIndex",
                    "preserveNullAndEmptyArrays",
                }

                if set(stage_value) - allowed_keys:
                    return False

                preserve = stage_value.get("preserveNullAndEmptyArrays")

                if preserve is not None and not isinstance(preserve, bool):
                    return False

            else:
                return False

        if not validate_pipeline_value(stage):
            return False

    return True


def validate_query(query):
    if not isinstance(query, dict):
        return False

    allowed_keys = {
        "collection", "operation", "filters",
        "fields", "field", "pipeline",
    }

    if set(query) - allowed_keys:
        return False

    collection = query.get("collection")
    operation = query.get("operation")

    if not validate_collection(collection):
        return False

    if not validate_operation(operation):
        return False

    filters = query.get("filters", {})
    fields = query.get("fields", [])

    if not validate_filters(collection, filters):
        return False

    if unsafe_anywhere(filters) or unsafe_anywhere(query.get("pipeline", [])):
        return False

    if not all(safe_regex(pattern) for pattern in _regexes(filters)):
        return False

    if operation == "count":
        return True

    if operation == "distinct":
        field = query.get("field")
        # distinct returns bare values under "value", so masking by field
        # name cannot apply: PII fields are refused instead.
        return (
            isinstance(field, str)
            and not is_pii_field(field)
            and validate_fields(collection, [field])
        )

    if operation == "find":
        return validate_fields(collection, fields)

    if operation == "aggregate":
        # Aggregation filters must be inside a $match stage.
        if filters:
            return False

        pipeline = query.get("pipeline", [])
        if references_pii(pipeline):
            return False
        if not all(safe_regex(pattern) for pattern in _regexes(pipeline)):
            return False
        if _join_count(pipeline) > MAX_JOINS:
            return False

        return validate_pipeline(pipeline)

    return False