# Camera-centered perception review

Accepted 2026-09-08.

The camera panel owns perception review and a recording shortcut. Manual results open on their exact captured frame; agent results populate history without stealing the selected view. A live inset and explicit historical label distinguish analysis from current observations. No tracking or repeated inference is implied.

Each submitted check saves its source image before provider submission. Existing source JSON carries kind, prompt, configured model and nullable recording ID; no destructive database migration is required. The association uses source capture time and the active recording when admission occurs. Checks that finish after Stop still belong to that recording. Interrupted jobs become visible failures on coordinator restart without refunding uncertain reservations.

History uses authenticated cursor pagination (25 records), detailed Effect Schema results, and saved source-image URLs. Older checks retain their preview but explicitly lack a source overlay. Recording review exposes corresponding markers. Camera recording uses its own pending state so inference cannot disable Stop recording. Robot Stop remains separate.

Raw training recordings and MP4 export semantics remain unchanged. Continuous tracking and annotated video exports are deferred. Overlay review makes no new paid requests; live provider verification still requires the operator's approved budget.
