<?php
/**
 * AI Label Review Queue (spec §8.1).
 *
 * Lowest AI confidence first, AI-suggested value beside the current value,
 * Approve / Edit-then-approve / Reject. Products flagged for pharmacist review
 * are visibly marked and their Approve control is disabled for anyone without
 * the capability — with the real check enforced server-side in the backend.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Admin_Labels {

	public static function init() {
		add_action( 'admin_post_wwc_review_label', array( __CLASS__, 'handle_review' ) );
		add_action( 'admin_post_wwc_relabel', array( __CLASS__, 'handle_relabel' ) );
		add_action( 'admin_post_wwc_bulk_approve', array( __CLASS__, 'handle_bulk_approve' ) );
		add_action( 'admin_post_wwc_reset_labels', array( __CLASS__, 'handle_reset_labels' ) );

		// AJAX, not admin-post.php: starting a labeling batch used to be a
		// blocking form submission that held the page open for the entire
		// run, which is exactly what surfaced as a stuck reload or a gateway
		// timeout once a batch ran longer than a request typically lives.
		// The backend now starts the job and returns immediately; these three
		// endpoints are what the page polls instead of waiting.
		add_action( 'wp_ajax_wwc_start_labeling', array( __CLASS__, 'ajax_start_labeling' ) );
		add_action( 'wp_ajax_wwc_labeling_status', array( __CLASS__, 'ajax_labeling_status' ) );
		add_action( 'wp_ajax_wwc_eligible_products', array( __CLASS__, 'ajax_eligible_products' ) );
	}

	public static function render() {
		WWC_Admin::page( __( 'AI Label Review Queue', 'wellness-chatbot' ), array( __CLASS__, 'body' ) );
	}

	public static function body() {
		WWC_Admin::render_notice_from_query();

		$page   = isset( $_GET['paged'] ) ? max( 1, (int) $_GET['paged'] ) : 1; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$limit  = 20;
		$result = WWC_Backend_Client::get(
			'/api/admin/labels/queue',
			array(
				'limit'  => $limit,
				'offset' => ( $page - 1 ) * $limit,
			)
		);

		if ( is_wp_error( $result ) ) {
			WWC_Admin::error_notice( $result );
			return;
		}

		$rows                 = isset( $result['rows'] ) && is_array( $result['rows'] ) ? $result['rows'] : array();
		$counts               = isset( $result['counts'] ) ? $result['counts'] : array();
		$models               = isset( $result['models'] ) && is_array( $result['models'] ) ? $result['models'] : array();
		$allow_non_pharmacist = ! empty( $result['allow_non_pharmacist_approval'] );

		self::render_summary( $counts );
		self::render_run_labeling( $counts, $models );

		if ( empty( $rows ) ) {
			echo '<p>' . esc_html__( 'Nothing is waiting for review. Run AI labeling above if products are still unverified.', 'wellness-chatbot' ) . '</p>';
		} else {
			echo '<p class="description">' . esc_html__( 'Sorted by lowest AI confidence first — the drafts most likely to be wrong are at the top.', 'wellness-chatbot' ) . '</p>';

			self::render_bulk_bar();

			foreach ( $rows as $row ) {
				self::render_row( $row, $allow_non_pharmacist );
			}

			self::render_pagination( $page, count( $rows ), $limit );
		}

		self::render_danger_zone( isset( $counts['queued'] ) ? (int) $counts['queued'] : 0 );
	}

	/**
	 * Starts a labeling batch directly against the catalogue already on the
	 * backend — no export, no upload, nothing else involved. This is the
	 * dashboard equivalent of running `npm run label:prod -- --limit N` in
	 * the backend's own terminal.
	 *
	 * Entirely JS-driven (see assets/js/admin.js) rather than a submitted
	 * form: starting used to block the page on the whole run via
	 * admin-post.php, which is exactly what surfaced as a stuck reload or a
	 * gateway timeout once a batch ran long. The backend now starts the job
	 * and returns immediately; these elements are what the polling script
	 * reads from and writes into. If a job is already running when this page
	 * loads, the script notices on its first status check and resumes
	 * showing it — you don't have to have been the one who started it.
	 *
	 * @param array $counts Product counts (for the "how many still need labeling" hint).
	 * @param array $models Current model config from the backend, so the cost
	 *                       this is about to incur is visible before it's incurred.
	 */
	private static function render_run_labeling( array $counts, array $models ) {
		$total       = isset( $counts['total'] ) ? (int) $counts['total'] : 0;
		$verified    = isset( $counts['verified'] ) ? (int) $counts['verified'] : 0;
		$queued      = isset( $counts['queued'] ) ? (int) $counts['queued'] : 0;
		$never_done  = max( 0, $total - $verified - $queued );
		$label_model = isset( $models['label'] ) ? (string) $models['label'] : null;

		echo '<div class="wwc-run-labeling" id="wwc-run-labeling">';
		echo '<h2>' . esc_html__( 'Run AI labeling', 'wellness-chatbot' ) . '</h2>';

		if ( $label_model ) {
			printf(
				'<p class="description" id="wwc-label-model-hint">%s</p>',
				esc_html(
					sprintf(
						/* translators: 1: model id, 2: number of never-labeled products. */
						__( 'Will run against %1$s. Roughly %2$d products have never been labeled at all.', 'wellness-chatbot' ),
						$label_model,
						$never_done
					)
				)
			);
			printf(
				'<p><button type="button" class="button-link" id="wwc-preview-eligible">%s</button></p>',
				esc_html__( 'Show me which products these are', 'wellness-chatbot' )
			);
			echo '<div id="wwc-eligible-list" class="wwc-eligible-list" hidden></div>';
		}

		echo '<div class="wwc-run-labeling-controls">';
		printf(
			'<label>%s <input type="number" id="wwc-label-limit" value="25" min="1" max="1000" class="small-text" /></label>',
			esc_html__( 'Label at most this many products:', 'wellness-chatbot' )
		);
		printf(
			' <label><input type="checkbox" id="wwc-label-reindex" checked="checked" /> %s</label>',
			esc_html__( 'rebuild search index afterwards', 'wellness-chatbot' )
		);
		printf(
			' <button type="button" class="button button-primary" id="wwc-label-start">%s</button>',
			esc_html__( 'Run AI labeling now', 'wellness-chatbot' )
		);
		echo '</div>';

		echo '<div id="wwc-label-progress" class="wwc-label-progress" hidden>';
		echo '<div class="wwc-label-progress-bar"><div class="wwc-label-progress-fill" id="wwc-label-progress-fill"></div></div>';
		echo '<p class="wwc-label-progress-summary" id="wwc-label-progress-summary"></p>';
		echo '<div class="wwc-label-log" id="wwc-label-log" role="log" aria-live="polite"></div>';
		echo '</div>';

		echo '<p class="description">' . esc_html__( 'Runs in the background on the server — you can leave this page and come back, or close the tab entirely, without stopping it.', 'wellness-chatbot' ) . '</p>';
		echo '</div>';
	}

	/**
	 * A form with (almost) nothing in it — the bulk-select checkboxes live
	 * inside each row card, wired to this form via the HTML `form=""`
	 * attribute rather than DOM nesting, since a `<form>` cannot nest inside
	 * another and each row keeps its own separate approve/reject form.
	 */
	private static function render_bulk_bar() {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" id="wwc-bulk-form" class="wwc-bulk-form">';
		wp_nonce_field( 'wwc_bulk_approve' );
		echo '<input type="hidden" name="action" value="wwc_bulk_approve" />';
		echo '</form>';

		echo '<div class="wwc-bulk-bar">';
		printf(
			'<label><input type="checkbox" id="wwc-select-all" /> %s</label>',
			esc_html__( 'Select all eligible on this page', 'wellness-chatbot' )
		);
		printf(
			'<button type="submit" form="wwc-bulk-form" class="button button-primary wwc-confirm-bulk" id="wwc-bulk-submit" disabled="disabled">%s</button>',
			esc_html__( 'Approve selected as partial', 'wellness-chatbot' )
		);
		printf(
			'<span class="description">%s</span>',
			esc_html__( 'Only products that need no pharmacist review and scored above the low-confidence line can be bulk approved. Everything else still needs its own look.', 'wellness-chatbot' )
		);
		echo '</div>';
	}

	/**
	 * A clearly separated, rarely-needed action: discards every unreviewed AI
	 * draft and resets the affected products to a clean, never-labeled state.
	 * Never touches anything a human has already verified or partially
	 * approved — enforced server-side, not just by this UI.
	 *
	 * @param int $queued Roughly how many products are currently unreviewed.
	 */
	private static function render_danger_zone( $queued ) {
		echo '<div class="wwc-danger-zone">';
		echo '<h2>' . esc_html__( 'Danger zone', 'wellness-chatbot' ) . '</h2>';
		printf(
			'<p class="description">%s</p>',
			esc_html(
				sprintf(
					/* translators: %d: number of products currently awaiting review. */
					__( 'Discards every unreviewed AI draft (roughly %d products right now) and resets them to a clean, never-labeled state — for when a labeling run used the wrong model, ran without a limit, or otherwise needs to be redone from scratch. Products you or your pharmacist have already approved are never touched.', 'wellness-chatbot' ),
					$queued
				)
			)
		);
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'wwc_reset_labels' );
		echo '<input type="hidden" name="action" value="wwc_reset_labels" />';
		printf(
			'<button type="submit" class="button button-link-delete wwc-confirm-reset">%s</button>',
			esc_html__( 'Clear all unreviewed AI drafts', 'wellness-chatbot' )
		);
		echo '</form>';
		echo '</div>';
	}

	private static function render_summary( $counts ) {
		$total    = isset( $counts['total'] ) ? (int) $counts['total'] : 0;
		$verified = isset( $counts['verified'] ) ? (int) $counts['verified'] : 0;
		$queued   = isset( $counts['queued'] ) ? (int) $counts['queued'] : 0;

		echo '<div class="wwc-cards">';
		printf( '<div class="wwc-card"><span class="wwc-card-value">%d</span><span class="wwc-card-label">%s</span></div>', (int) $total, esc_html__( 'Products synced', 'wellness-chatbot' ) );
		printf( '<div class="wwc-card"><span class="wwc-card-value">%d</span><span class="wwc-card-label">%s</span></div>', (int) $verified, esc_html__( 'Recommendable', 'wellness-chatbot' ) );
		printf( '<div class="wwc-card"><span class="wwc-card-value">%d</span><span class="wwc-card-label">%s</span></div>', (int) $queued, esc_html__( 'Awaiting review', 'wellness-chatbot' ) );
		echo '</div>';
	}

	private static function render_row( array $row, $allow_non_pharmacist = false ) {
		$product_id  = isset( $row['product_id'] ) ? (int) $row['product_id'] : 0;
		$draft_id    = isset( $row['draft_id'] ) ? (int) $row['draft_id'] : 0;
		$confidence  = isset( $row['confidence'] ) ? (float) $row['confidence'] : 0.0;
		$needs_rx    = ! empty( $row['requires_pharmacist_review'] );
		$low_conf    = ! empty( $row['low_confidence'] );
		$draft       = isset( $row['draft'] ) && is_array( $row['draft'] ) ? $row['draft'] : array();
		// Mirrors the backend's own gate (see checkEligibility/applyReview):
		// a non-pharmacist admin may approve a flagged product only when the
		// store has explicitly turned ALLOW_NON_PHARMACIST_APPROVAL on.
		$can_approve = ! $needs_rx || WWC_Roles::current_user_is_pharmacist() || $allow_non_pharmacist;

		$bulk_eligible = ! $needs_rx && ! $low_conf;

		echo '<div class="wwc-review-card' . ( $low_conf ? ' wwc-low-confidence' : '' ) . '">';

		echo '<div class="wwc-review-head">';
		if ( $bulk_eligible ) {
			printf(
				'<input type="checkbox" class="wwc-row-check" name="draft_ids[]" value="%1$d" form="wwc-bulk-form" aria-label="%2$s" />',
				(int) $draft_id,
				esc_attr__( 'Select for bulk approval', 'wellness-chatbot' )
			);
			printf( '<input type="hidden" name="product_for_%1$d" value="%2$d" form="wwc-bulk-form" />', (int) $draft_id, (int) $product_id );
		}
		if ( ! empty( $row['image_url'] ) ) {
			printf( '<img src="%s" alt="" class="wwc-thumb" />', esc_url( $row['image_url'] ) );
		}
		echo '<div>';
		printf(
			'<h2>%s <a href="%s" class="wwc-edit-link">%s</a></h2>',
			esc_html( isset( $row['name'] ) ? $row['name'] : '' ),
			esc_url( get_edit_post_link( $product_id ) ),
			esc_html__( 'edit product', 'wellness-chatbot' )
		);
		printf(
			'<p class="wwc-meta">%s &middot; %s %s</p>',
			esc_html( isset( $row['category'] ) ? (string) $row['category'] : __( 'category unresolved', 'wellness-chatbot' ) ),
			esc_html( sprintf( /* translators: %s: confidence value. */ __( 'AI confidence %s', 'wellness-chatbot' ), number_format_i18n( $confidence, 2 ) ) ),
			$low_conf ? '<span class="wwc-flag wwc-flag-warn">' . esc_html__( 'low confidence', 'wellness-chatbot' ) . '</span>' : ''
		);
		if ( $needs_rx ) {
			$rx_notice = $allow_non_pharmacist
				? __( 'Pharmacist review normally required — currently any admin may approve this product (Settings: Allow non-pharmacist approval is on).', 'wellness-chatbot' )
				: __( 'Pharmacist review required — only a Pharmacist Reviewer can verify this product.', 'wellness-chatbot' );
			echo '<p class="wwc-flag wwc-flag-rx">' . esc_html( $rx_notice ) . '</p>';
		}
		echo '</div></div>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="wwc-review-form">';
		wp_nonce_field( 'wwc_review_label' );
		echo '<input type="hidden" name="action" value="wwc_review_label" />';
		printf( '<input type="hidden" name="product_id" value="%d" />', (int) $product_id );
		printf( '<input type="hidden" name="draft_id" value="%d" />', (int) $draft_id );

		self::render_fields( $product_id, $draft );

		echo '<div class="wwc-review-actions">';
		printf(
			'<button type="submit" name="decision" value="approve_verified" class="button button-primary"%s>%s</button>',
			$can_approve ? '' : ' disabled="disabled"',
			esc_html__( 'Approve as verified', 'wellness-chatbot' )
		);
		printf(
			'<button type="submit" name="decision" value="approve_partial" class="button">%s</button>',
			esc_html__( 'Approve as partial', 'wellness-chatbot' )
		);
		printf(
			'<button type="submit" name="decision" value="reject" class="button button-link-delete wwc-confirm-reject">%s</button>',
			esc_html__( 'Reject', 'wellness-chatbot' )
		);
		echo '</div>';
		echo '</form>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="wwc-relabel-form">';
		wp_nonce_field( 'wwc_relabel' );
		echo '<input type="hidden" name="action" value="wwc_relabel" />';
		printf( '<input type="hidden" name="product_id" value="%d" />', (int) $product_id );
		printf( '<button type="submit" class="button-link">%s</button>', esc_html__( 'Re-run AI labeling', 'wellness-chatbot' ) );
		echo '</form>';

		echo '</div>';
	}

	/**
	 * Side-by-side AI suggestion vs. the value currently stored on the product.
	 *
	 * @param int   $product_id Product ID.
	 * @param array $draft      AI draft.
	 */
	private static function render_fields( $product_id, array $draft ) {
		$fields = array(
			'name_ar'            => __( 'Arabic name', 'wellness-chatbot' ),
			'concern_primary'    => __( 'Main concerns', 'wellness-chatbot' ),
			'concern_secondary'  => __( 'Secondary concerns', 'wellness-chatbot' ),
			'suitable_types'     => __( 'Suitable types', 'wellness-chatbot' ),
			'not_ideal_for'      => __( 'Not ideal for', 'wellness-chatbot' ),
			'key_ingredients'    => __( 'Key ingredients', 'wellness-chatbot' ),
			'texture_finish'     => __( 'Texture / finish', 'wellness-chatbot' ),
			'fragrance'          => __( 'Fragrance', 'wellness-chatbot' ),
			'alcohol'            => __( 'Alcohol', 'wellness-chatbot' ),
			'how_to_use'         => __( 'How to use', 'wellness-chatbot' ),
			'routine_step'       => __( 'Routine step', 'wellness-chatbot' ),
			'age_suitability'    => __( 'Age suitability', 'wellness-chatbot' ),
			'warnings'           => __( 'Warnings', 'wellness-chatbot' ),
			'serving_size'       => __( 'Serving size (as printed)', 'wellness-chatbot' ),
			'key_amounts'        => __( 'Key amounts (as printed)', 'wellness-chatbot' ),
		);

		echo '<table class="wwc-fields"><thead><tr>';
		echo '<th>' . esc_html__( 'Field', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Currently stored', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'AI suggestion (editable)', 'wellness-chatbot' ) . '</th>';
		echo '</tr></thead><tbody>';

		foreach ( $fields as $key => $label ) {
			if ( ! array_key_exists( $key, $draft ) ) {
				continue;
			}

			$current   = self::current_value( $product_id, $key );
			$suggested = self::flatten( $draft[ $key ] );

			echo '<tr>';
			echo '<th scope="row">' . esc_html( $label ) . '</th>';
			echo '<td class="wwc-current">' . ( '' === $current ? '<em>' . esc_html__( 'empty', 'wellness-chatbot' ) . '</em>' : esc_html( $current ) ) . '</td>';
			printf(
				'<td><textarea name="edits[%s]" rows="2" class="widefat">%s</textarea></td>',
				esc_attr( $key ),
				esc_textarea( $suggested )
			);
			echo '</tr>';
		}

		echo '</tbody></table>';
		printf(
			'<p><label>%s<br /><input type="text" name="note" class="widefat" placeholder="%s" /></label></p>',
			esc_html__( 'Review note (stored in the audit trail)', 'wellness-chatbot' ),
			esc_attr__( 'e.g. checked against the manufacturer leaflet', 'wellness-chatbot' )
		);
	}

	private static function current_value( $product_id, $key ) {
		$map = array(
			'name_ar'           => '_wwc_name_ar',
			'concern_primary'   => '_wwc_concern_primary_en',
			'concern_secondary' => '_wwc_concern_secondary_en',
			'suitable_types'    => '_wwc_suitable_types_en',
			'not_ideal_for'     => '_wwc_not_ideal_for_en',
			'key_ingredients'   => '_wwc_key_ingredients',
			'texture_finish'    => '_wwc_texture_finish_en',
			'fragrance'         => '_wwc_fragrance',
			'alcohol'           => '_wwc_alcohol',
			'how_to_use'        => '_wwc_how_to_use_en',
			'routine_step'      => '_wwc_routine_step',
			'age_suitability'   => '_wwc_age_suitability',
			'warnings'          => '_wwc_warnings_en',
		);

		if ( ! isset( $map[ $key ] ) ) {
			return '';
		}
		return self::flatten( get_post_meta( $product_id, $map[ $key ], true ) );
	}

	/**
	 * Renders any draft value as editable text.
	 *
	 * @param mixed $value Value.
	 * @return string
	 */
	private static function flatten( $value ) {
		if ( null === $value ) {
			return '';
		}
		if ( is_array( $value ) ) {
			// Bilingual pairs render as "en | ar"; plain lists as a comma list.
			if ( isset( $value['en'] ) || isset( $value['ar'] ) ) {
				$en = isset( $value['en'] ) ? ( is_array( $value['en'] ) ? implode( ', ', $value['en'] ) : (string) $value['en'] ) : '';
				$ar = isset( $value['ar'] ) ? ( is_array( $value['ar'] ) ? implode( ', ', $value['ar'] ) : (string) $value['ar'] ) : '';
				return trim( $en . ( '' !== $ar ? ' | ' . $ar : '' ) );
			}
			return implode( ', ', array_map( 'strval', $value ) );
		}
		if ( is_bool( $value ) ) {
			return $value ? 'yes' : 'no';
		}
		return (string) $value;
	}

	public static function handle_review() {
		WWC_Admin::verify_post( 'wwc_review_label' );

		$product_id = isset( $_POST['product_id'] ) ? (int) $_POST['product_id'] : 0;
		$draft_id   = isset( $_POST['draft_id'] ) ? (int) $_POST['draft_id'] : 0;
		$decision   = isset( $_POST['decision'] ) ? sanitize_key( wp_unslash( $_POST['decision'] ) ) : '';
		$note       = isset( $_POST['note'] ) ? sanitize_text_field( wp_unslash( $_POST['note'] ) ) : '';

		$edits = array();
		if ( isset( $_POST['edits'] ) && is_array( $_POST['edits'] ) ) {
			foreach ( wp_unslash( $_POST['edits'] ) as $key => $value ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
				$edits[ sanitize_key( $key ) ] = sanitize_textarea_field( $value );
			}
		}

		$action = ( 'reject' === $decision ) ? 'reject' : 'approve';
		$status = ( 'approve_partial' === $decision ) ? 'partial' : 'verified';

		// The backend is the sole authority on the pharmacist gate — it already
		// accounts for ALLOW_NON_PHARMACIST_APPROVAL, which a local pre-check
		// here would not. Its 403 response (handled below) covers this case.
		$response = WWC_Backend_Client::post(
			'/api/admin/labels/' . $product_id,
			array(
				'draft_id' => $draft_id,
				'action'   => $action,
				'status'   => $status,
				'edits'    => self::edits_to_payload( $edits ),
				'note'     => $note,
			)
		);

		if ( is_wp_error( $response ) ) {
			$data   = $response->get_error_data();
			$notice = ( is_array( $data ) && isset( $data['status'] ) && 403 === (int) $data['status'] )
				? 'pharmacist_required'
				: 'failed';
			WWC_Admin::redirect_back( WWC_Admin::MENU_SLUG, array( 'wwc_notice' => $notice ) );
		}

		// Mirror the approved values onto the product so WooCommerce stays the
		// system of record for anything a human confirmed.
		if ( 'approve' === $action ) {
			self::mirror_to_meta( $product_id, $edits, $status );
		}

		WWC_Admin::redirect_back(
			WWC_Admin::MENU_SLUG,
			array( 'wwc_notice' => 'approve' === $action ? 'approved' : 'rejected' )
		);
	}

	/**
	 * Turns the flat textarea edits back into the structured shapes the backend
	 * stores. "en | ar" splits into a bilingual pair; comma lists into arrays.
	 *
	 * @param array $edits Raw edits.
	 * @return array
	 */
	private static function edits_to_payload( array $edits ) {
		$bilingual_lists = array( 'concern_primary', 'concern_secondary', 'suitable_types' );
		$bilingual_text  = array( 'not_ideal_for', 'texture_finish', 'how_to_use', 'warnings' );
		$plain_lists     = array( 'key_ingredients', 'synonyms_en', 'synonyms_ar' );

		$payload = array();
		foreach ( $edits as $key => $value ) {
			$value = trim( (string) $value );

			if ( in_array( $key, $bilingual_lists, true ) ) {
				$parts            = array_map( 'trim', explode( '|', $value ) );
				$payload[ $key ] = array(
					'en' => self::split_list( isset( $parts[0] ) ? $parts[0] : '' ),
					'ar' => self::split_list( isset( $parts[1] ) ? $parts[1] : '' ),
				);
				continue;
			}

			if ( in_array( $key, $bilingual_text, true ) ) {
				$parts            = array_map( 'trim', explode( '|', $value ) );
				$payload[ $key ] = array(
					'en' => ( isset( $parts[0] ) && '' !== $parts[0] ) ? $parts[0] : null,
					'ar' => ( isset( $parts[1] ) && '' !== $parts[1] ) ? $parts[1] : null,
				);
				continue;
			}

			if ( in_array( $key, $plain_lists, true ) ) {
				$payload[ $key ] = self::split_list( $value );
				continue;
			}

			$payload[ $key ] = '' === $value ? null : $value;
		}

		return $payload;
	}

	private static function split_list( $value ) {
		if ( '' === trim( (string) $value ) ) {
			return array();
		}
		return array_values( array_filter( array_map( 'trim', explode( ',', (string) $value ) ) ) );
	}

	/**
	 * @param int    $product_id Product ID.
	 * @param array  $edits      Approved values.
	 * @param string $status     verified|partial.
	 */
	private static function mirror_to_meta( $product_id, array $edits, $status ) {
		$simple = array(
			'name_ar'         => '_wwc_name_ar',
			'fragrance'       => '_wwc_fragrance',
			'alcohol'         => '_wwc_alcohol',
			'routine_step'    => '_wwc_routine_step',
			'age_suitability' => '_wwc_age_suitability',
		);

		foreach ( $simple as $key => $meta_key ) {
			if ( isset( $edits[ $key ] ) ) {
				update_post_meta( $product_id, $meta_key, $edits[ $key ] );
			}
		}

		$bilingual = array(
			'not_ideal_for'  => '_wwc_not_ideal_for',
			'texture_finish' => '_wwc_texture_finish',
			'how_to_use'     => '_wwc_how_to_use',
			'warnings'       => '_wwc_warnings',
		);

		foreach ( $bilingual as $key => $base ) {
			if ( ! isset( $edits[ $key ] ) ) {
				continue;
			}
			$parts = array_map( 'trim', explode( '|', (string) $edits[ $key ] ) );
			update_post_meta( $product_id, $base . '_en', isset( $parts[0] ) ? $parts[0] : '' );
			update_post_meta( $product_id, $base . '_ar', isset( $parts[1] ) ? $parts[1] : '' );
		}

		if ( isset( $edits['key_ingredients'] ) ) {
			update_post_meta( $product_id, '_wwc_key_ingredients', self::split_list( $edits['key_ingredients'] ) );
		}

		update_post_meta( $product_id, '_wwc_ai_generated', '0' );
		update_post_meta( $product_id, '_wwc_source_verification_date', gmdate( 'Y-m-d' ) );

		// This point is only reached after the backend has already
		// authoritatively approved the write (it would have 403'd above
		// otherwise), so the local pharmacist-only gate is bypassed here —
		// it exists to protect direct meta edits, not to re-litigate a
		// decision the backend already made.
		WWC_Meta::set_verification_status( $product_id, $status, true );
	}

	public static function handle_relabel() {
		WWC_Admin::verify_post( 'wwc_relabel' );
		$product_id = isset( $_POST['product_id'] ) ? (int) $_POST['product_id'] : 0;

		$response = WWC_Backend_Client::post( '/api/admin/labels/' . $product_id . '/relabel', array(), array( 'timeout' => 90 ) );
		WWC_Admin::redirect_back(
			WWC_Admin::MENU_SLUG,
			array( 'wwc_notice' => is_wp_error( $response ) ? 'failed' : 'relabeled' )
		);
	}

	/**
	 * Bulk approve, restricted to drafts that are NOT flagged for pharmacist
	 * review — the spec allows bulk only for low-risk categories.
	 */
	public static function handle_bulk_approve() {
		WWC_Admin::verify_post( 'wwc_bulk_approve' );

		$drafts = isset( $_POST['draft_ids'] ) ? array_map( 'intval', (array) wp_unslash( $_POST['draft_ids'] ) ) : array();
		$failed = 0;

		foreach ( $drafts as $draft_id ) {
			$product_id = isset( $_POST[ 'product_for_' . $draft_id ] ) ? (int) $_POST[ 'product_for_' . $draft_id ] : 0;
			if ( ! $product_id || WWC_Meta::requires_pharmacist_review( $product_id ) ) {
				++$failed;
				continue;
			}

			$response = WWC_Backend_Client::post(
				'/api/admin/labels/' . $product_id,
				array(
					'draft_id' => $draft_id,
					'action'   => 'approve',
					'status'   => 'partial',
					'note'     => __( 'Bulk approved', 'wellness-chatbot' ),
				)
			);
			if ( is_wp_error( $response ) ) {
				++$failed;
			} else {
				WWC_Meta::set_verification_status( $product_id, WWC_Meta::STATUS_PARTIAL );
			}
		}

		WWC_Admin::redirect_back(
			WWC_Admin::MENU_SLUG,
			array( 'wwc_notice' => $failed > 0 ? 'failed' : 'approved' )
		);
	}

	/**
	 * Discards every unreviewed AI draft and resets the affected products.
	 * The backend independently guarantees this can never touch a
	 * verified/partial product — this handler doesn't need to re-check that,
	 * only pass the confirmation through.
	 */
	public static function handle_reset_labels() {
		WWC_Admin::verify_post( 'wwc_reset_labels' );

		$response = WWC_Backend_Client::post(
			'/api/admin/labels/reset-unreviewed',
			array( 'confirm' => true ),
			array( 'timeout' => 60 )
		);

		WWC_Admin::redirect_back(
			WWC_Admin::MENU_SLUG,
			array( 'wwc_notice' => is_wp_error( $response ) ? 'failed' : 'reset' )
		);
	}

	/**
	 * Verifies the AJAX nonce and capability, common to all three handlers
	 * below. Dies with a JSON error (via wp_send_json_error) rather than
	 * wp_die()'s HTML page — the caller is JS reading a response body, not a
	 * browser navigating to a new page.
	 *
	 * @return bool True if the request may proceed.
	 */
	private static function ajax_guard() {
		check_ajax_referer( 'wwc_admin', 'nonce' );
		if ( ! WWC_Roles::can_manage() ) {
			wp_send_json_error( array( 'message' => __( 'You do not have permission to do that.', 'wellness-chatbot' ) ), 403 );
			return false;
		}
		return true;
	}

	/**
	 * Starts a labeling batch with no catalogue upload involved — the
	 * dashboard equivalent of `npm run label:prod -- --limit N` on the
	 * backend server. This call itself returns almost immediately (the
	 * backend starts the job and responds without waiting for it), so it
	 * never risks the timeout the old admin-post.php version could hit.
	 */
	public static function ajax_start_labeling() {
		if ( ! self::ajax_guard() ) {
			return;
		}

		// Same rule as the upload screen: a missing or non-positive value
		// falls back to a safe default rather than reaching the backend as
		// "no limit" — this control must never be able to relabel an entire
		// catalogue in one uncontrolled run.
		$limit = isset( $_POST['limit'] ) ? absint( $_POST['limit'] ) : 0;
		if ( $limit < 1 ) {
			$limit = 25;
		}
		$limit = min( $limit, 1000 );

		$response = WWC_Backend_Client::post(
			'/api/admin/labels/run',
			array(
				'limit'   => $limit,
				'reindex' => ! empty( $_POST['reindex'] ),
			),
			array( 'timeout' => 15 )
		);

		if ( is_wp_error( $response ) ) {
			$data   = $response->get_error_data();
			$status = ( is_array( $data ) && isset( $data['status'] ) ) ? (int) $data['status'] : 500;
			$body   = ( is_array( $data ) && isset( $data['body'] ) && is_array( $data['body'] ) ) ? $data['body'] : array();
			// A 409 means one is already running — forward its job state too,
			// so the page can switch straight into watching it instead of just
			// showing a dead-end error.
			wp_send_json_error(
				array(
					'message' => $response->get_error_message(),
					'job'     => isset( $body['job'] ) ? $body['job'] : null,
				),
				$status
			);
		}

		wp_send_json_success( $response );
	}

	/**
	 * Polled every couple of seconds by the page while a run is in progress.
	 */
	public static function ajax_labeling_status() {
		if ( ! self::ajax_guard() ) {
			return;
		}

		$response = WWC_Backend_Client::get( '/api/admin/labels/run/status' );
		if ( is_wp_error( $response ) ) {
			wp_send_json_error( array( 'message' => $response->get_error_message() ), 502 );
		}

		wp_send_json_success( $response );
	}

	/**
	 * "Show me which products these are" — names, not just a count, of
	 * products a run would actually touch, so an admin can look before
	 * spending anything finding out.
	 */
	public static function ajax_eligible_products() {
		if ( ! self::ajax_guard() ) {
			return;
		}

		$response = WWC_Backend_Client::get( '/api/admin/labels/eligible', array( 'limit' => 100 ) );
		if ( is_wp_error( $response ) ) {
			wp_send_json_error( array( 'message' => $response->get_error_message() ), 502 );
		}

		wp_send_json_success( $response );
	}

	private static function render_pagination( $page, $count, $limit ) {
		echo '<div class="wwc-pagination">';
		if ( $page > 1 ) {
			printf(
				'<a class="button" href="%s">&laquo; %s</a> ',
				esc_url( add_query_arg( 'paged', $page - 1, admin_url( 'admin.php?page=' . WWC_Admin::MENU_SLUG ) ) ),
				esc_html__( 'Previous', 'wellness-chatbot' )
			);
		}
		if ( $count >= $limit ) {
			printf(
				'<a class="button" href="%s">%s &raquo;</a>',
				esc_url( add_query_arg( 'paged', $page + 1, admin_url( 'admin.php?page=' . WWC_Admin::MENU_SLUG ) ) ),
				esc_html__( 'Next', 'wellness-chatbot' )
			);
		}
		echo '</div>';
	}
}
