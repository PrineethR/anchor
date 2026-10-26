# Harness report — 2026-10-26 14:52

Pages: 1

## Text

| metric | value |
|---|---|
| detection_p | 1.000 |
| detection_r | 1.000 |
| detection_f1 | 1.000 |
| cer_matched | 0.006 |
| cer_end_to_end | 0.006 |
| exact_match_rate | 0.955 |

## Links

| metric | value |
|---|---|
| top1_p | 0.929 |
| top1_r | 0.929 |
| top1_f1 | 0.929 |
| top2_recall | 0.929 |
| reversed | 0 |
| kind_accuracy | 1.000 |
| connector_label_accuracy | 1.000 |
| mean_conf_correct | 0.931 |
| mean_conf_wrong | 0.950 |

## Emphasis

| metric | value |
|---|---|
| underline_p | 1.000 |
| underline_r | 0.923 |
| underline_f1 | 0.960 |
| caps_p | 0.750 |
| caps_r | 0.750 |
| caps_f1 | 0.750 |
| shape_f1 | 1.000 |
| container_jaccard | 1.000 |

## Doodles

| metric | value |
|---|---|
| gold | 1 |
| f1 | 1.000 |
| read_as_text | 0 |

## Per page

| page | text F1 | CER | link F1 | top-2 R | underline F1 | caps F1 |
|---|---|---|---|---|---|---|
| page-01 | 1.000 | 0.006 | 0.929 | 0.929 | 0.960 | 0.750 |

## Errors

### page-01
- misread add_luis: 'Add Luis Garcia' -> 'Add ?\nLuis\nGarcia'
- missed link transition->core (connector)
- spurious link transition->core_shape (connector)
