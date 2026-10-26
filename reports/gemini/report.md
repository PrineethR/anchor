# Harness report — 2026-10-26 14:20

Pages: 1

## Text

| metric | value |
|---|---|
| detection_p | 0.957 |
| detection_r | 1.000 |
| detection_f1 | 0.978 |
| cer_matched | 0.006 |
| cer_end_to_end | 0.006 |
| exact_match_rate | 0.909 |

## Links

| metric | value |
|---|---|
| top1_p | 0.867 |
| top1_r | 0.929 |
| top1_f1 | 0.897 |
| top2_recall | 0.929 |
| reversed | 0 |
| kind_accuracy | 0.846 |
| connector_label_accuracy | 1.000 |
| mean_conf_correct | 0.923 |
| mean_conf_wrong | 0.925 |

## Emphasis

| metric | value |
|---|---|
| underline_p | 1.000 |
| underline_r | 0.538 |
| underline_f1 | 0.700 |
| caps_p | 0.750 |
| caps_r | 0.750 |
| caps_f1 | 0.750 |
| shape_f1 | 1.000 |
| container_jaccard | 0.500 |

## Doodles

| metric | value |
|---|---|
| gold | 1 |
| f1 | 0.000 |
| read_as_text | 0 |

## Per page

| page | text F1 | CER | link F1 | top-2 R | underline F1 | caps F1 |
|---|---|---|---|---|---|---|
| page-01 | 0.978 | 0.006 | 0.897 | 0.929 | 0.700 | 0.750 |

## Errors

### page-01
- underline mindset 'mindset of posture.': gold=True pred=False
- underline eu 'Looking into EU.': gold=True pred=False
- misread add_luis: 'Add Luis Garcia' -> 'Add?\nLuis\nGarcia'
- underline add_luis 'Add Luis Garcia': gold=True pred=False
- underline critique 'CRITIQUE': gold=True pred=False
- misread tdesign: 'of transition design.' -> 'of transition\ndesign'
- underline play 'PLAY is TRANSITION & TRANSITION is PLAY': gold=True pred=False
- shape core_shape contents: gold=['core', 'doodle_o'] pred=['core']
- missed link transition->core (connector)
- link kind thread->story (flow): pred hook
- link kind critique->tdesign (flow): pred connector
- spurious link transition->core_shape (flow)
- spurious link pred:t3->core_shape (flow)
