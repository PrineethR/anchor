# Harness report — 2026-10-12 13:14

Pages: 1

## Text

| metric | value |
|---|---|
| detection_p | 0.800 |
| detection_r | 0.727 |
| detection_f1 | 0.762 |
| cer_matched | 0.352 |
| cer_end_to_end | 0.499 |
| exact_match_rate | 0.136 |

## Links

| metric | value |
|---|---|
| top1_p | 1.000 |
| top1_r | 0.000 |
| top1_f1 | 0.000 |
| top2_recall | 0.000 |
| reversed | 0 |
| kind_accuracy | n/a |
| connector_label_accuracy | n/a |
| mean_conf_correct | n/a |
| mean_conf_wrong | n/a |

## Emphasis

| metric | value |
|---|---|
| underline_p | 1.000 |
| underline_r | 0.000 |
| underline_f1 | 0.000 |
| caps_p | 1.000 |
| caps_r | 0.750 |
| caps_f1 | 0.857 |
| shape_f1 | 0.000 |
| container_jaccard | n/a |

## Doodles

| metric | value |
|---|---|
| gold | 1 |
| f1 | 0.000 |
| read_as_text | 0 |

## Per page

| page | text F1 | CER | link F1 | top-2 R | underline F1 | caps F1 |
|---|---|---|---|---|---|---|
| page-01 | 0.762 | 0.499 | 0.000 | 0.000 | 0.000 | 0.857 |

## Errors

### page-01
- misread transition: 'Transition' -> 'Frankhor'
- misread curiosity: 'curiosity' -> 'Lauriotity'
- misread core: 'core' -> 'Ocore'
- misread peripheral: 'peripheral units' -> 'perpueral units'
- underline peripheral 'peripheral units': gold=True pred=False
- misread idea: 'the idea of transitions' -> 'travishon'
- underline idea 'the idea of transitions': gold=True pred=False
- missed text transdisc 'transdisciplinarity'
- missed text grounded 'stay grounded.'
- misread mindset: 'mindset of posture.' -> 'mindset of partue.'
- underline mindset 'mindset of posture.': gold=True pred=False
- missed text eu 'Looking into EU.'
- misread phds_design: 'PhDs in Design' -> 'PhDS in Desig'
- underline phds_design 'PhDs in Design': gold=True pred=False
- misread add_luis: 'Add Luis Garcia' -> 'Add.? Luis Garcia PhDs на'
- underline add_luis 'Add Luis Garcia': gold=True pred=False
- missed text phds_hci 'PhDs in HCI'
- misread thread: 'a connecting thread.' -> 'connechn wread'
- underline thread 'a connecting thread.': gold=True pred=False
- missed text tangible 'tangible'
- missed text intangible 'intangible'
- misread society: 'the way we think about design & society.' -> 'we think about derm e socery'
- underline society 'the way we think about design & society.': gold=True pred=False
- underline framework 'framework.': gold=True pred=False
- misread critique: 'CRITIQUE' -> 'CRITQUE'
- underline critique 'CRITIQUE': gold=True pred=False
- misread tdesign: 'of transition design.' -> 'of trantition'
- underline tdesign 'of transition design.': gold=True pred=False
- misread play: 'PLAY is TRANSITION & TRANSITION is PLAY' -> "PLAI 'STRANGTION X RANSTON"
- underline play 'PLAY is TRANSITION & TRANSITION is PLAY': gold=True pred=False
- missed shape core_shape
- missed link transition->core (connector)
- missed link transition->curiosity (hook)
- missed link core_shape->peripheral (flow)
- missed link core_shape->mindset (flow)
- missed link idea->transdisc (flow)
- missed link transdisc->grounded (flow)
- missed link eu->phds_design (flow)
- missed link thread->story (flow)
- missed link story->play (flow)
- missed link tangible->intangible (connector)
- missed link intangible->gaps (flow)
- missed link gaps->framework (flow)
- missed link gaps->critique (flow)
- missed link critique->tdesign (flow)
