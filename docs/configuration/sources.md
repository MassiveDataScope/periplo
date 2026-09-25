# Sources file

The sources file tells Periplo where to look for Delta tables and what the folders
above each table mean. It is a YAML file named by `PERIPLO_SOURCES_FILE`
(`/etc/periplo/sources.yaml` in the container image) and read once, at start-up.

The file is strict on purpose: an unknown field, a repeated source name or a malformed
template stops the start-up with a message that names the entry, instead of silently
changing what gets discovered. Credentials never go in this file; see
{doc}`environment`.

## A complete example

```yaml
version: 1

sources:
  - name: shop
    uri: s3://shop-lake/                     # bucket and root prefix
    template: "{layer}/{domain}/{table}"     # what each folder above a table means
    include: [raw, curated]                  # optional: first-level folders to look into
    labels: { environment: prod }            # optional: labels for every table of this source

  - name: shop_staging                       # a twin bucket with the same layout
    uri: s3://shop-lake-staging/
    template: "{layer}/{domain}/{table}"
    database_prefix: stg_                    # keeps its names apart from `shop`
    labels: { environment: staging }

explorer:                                    # optional
  group_by: [stage]                          # nests the explorer: stage, then database
  values:
    layer:                                   # a folder name can stand for more labels
      raw: { labels: { stage: landing } }
      curated: { labels: { stage: refined } }
    stage:                                   # titles, descriptions and order for display
      landing: { title: "Landing", description: "As received from the shop.", order: 1 }
      refined: { title: "Refined", description: "Cleaned and ready to analyse.", order: 2 }
```

The repository's `config/sources.example.yaml` is another worked example; it is what the
container image starts with.

## Top level

| Field | Required | Meaning |
|-------|----------|---------|
| `version` | yes | Format version. This release reads `1`. |
| `sources` | yes | One or more sources, described below. |
| `explorer` | no | How the web console groups and presents tables. |

## Sources

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | Unique name of the source, matching `[a-z][a-z0-9_]*`. |
| `uri` | yes | An `s3://bucket/prefix/` location. Only S3 is supported. |
| `template` | yes | What each folder level between `uri` and a table means; see [Templates](#templates). |
| `include` | no | First-level folder names to look into; others are skipped. Without it, every folder is searched. |
| `database_prefix` | no | Text put in front of every database name of this source, for example to keep two buckets with the same layout apart. |
| `labels` | no | Labels given to every table of the source. A label may not have the name of a template level. |

## Templates

A template is a list of `{name}` levels separated by `/`, ending in `{table}`, for
example `{layer}/{domain}/{table}`. Level names match `[a-z][a-z0-9_]*`, may not repeat,
and `{table}` appears only once, at the end.

### How tables are found

Discovery lists the folders under each source, level by level:

- A table is the first folder, going down from the source root, that holds a
  `_delta_log` folder. Discovery never goes inside a table, so partitions cost nothing.
- Folders whose name starts with `_` or `.` are never entered.
- Discovery searches down to two levels deeper than the template, and lists at most
  `PERIPLO_DISCOVERY_FOLDER_BUDGET` folders per source; reaching the budget makes the
  result partial.

### How tables are named

For a table at `s3://shop-lake/curated/sales/orders/` and the template
`{layer}/{domain}/{table}`:

| Result | Value | Rule |
|--------|-------|------|
| table | `orders` | The name of the table's own folder. |
| database | `curated_sales` | The folders above the table joined with `_`, after `database_prefix`. |
| labels | `layer: curated`, `domain: sales` | Each folder above the table gives the level at the same position its value. |

Folder names become SQL names in lowercase, with every character outside `[a-z0-9_]`
replaced by `_` and a `_` in front of a leading digit. A table directly under the source
root uses the source name as its database.

A path shallower than the template leaves the last levels without a value; a deeper one
keeps its extra folders in the database name, without a label.

If two paths produce the same `database.table`, neither is published: the discovery page
reports the conflict instead of picking one, because a query must never read the wrong
table.

## Explorer

| Field | Meaning |
|-------|---------|
| `group_by` | Labels that nest the explorer, outermost first, before the databases. |
| `values` | Per label, per value: `title`, `description` and `order` for display, and `labels` that the value stands for. |

A value's `labels` let one folder name mean several things. In the example, every table
under the `raw` folder also gets the label `stage: landing`. Such derived labels may not
reuse the name of a template level or of a fixed source label.

## Discovering again

The first discovery starts when the application starts; `/health/ready` answers `503`
until it has finished. After that, the catalog changes only when a new discovery is
requested, from the console's discovery page or with `POST /api/v1/discovery`. Asking
while one is running joins the one already running.
