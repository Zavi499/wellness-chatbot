<?php
/**
 * Knowledge Base / FAQ editor (spec §8.2, §7).
 *
 * Bilingual entries with an approval state. Unapproved entries are never served
 * to a customer — the assistant uses the approved fallback wording instead.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Admin_Kb {

	const PAGE = 'wellness-chatbot-kb';

	public static function init() {
		add_action( 'admin_post_wwc_save_kb', array( __CLASS__, 'handle_save' ) );
		add_action( 'admin_post_wwc_delete_kb', array( __CLASS__, 'handle_delete' ) );
	}

	public static function render() {
		WWC_Admin::page( __( 'Knowledge Base', 'wellness-chatbot' ), array( __CLASS__, 'body' ) );
	}

	public static function body() {
		WWC_Admin::render_notice_from_query();

		$result = WWC_Backend_Client::get( '/api/admin/kb' );
		if ( is_wp_error( $result ) ) {
			WWC_Admin::error_notice( $result );
			return;
		}

		$entries    = isset( $result['entries'] ) && is_array( $result['entries'] ) ? $result['entries'] : array();
		$unanswered = array_filter(
			$entries,
			function ( $e ) {
				return empty( $e['answer_en'] ) && empty( $e['answer_ar'] );
			}
		);

		if ( ! empty( $unanswered ) ) {
			printf(
				'<div class="notice notice-warning"><p>%s</p></div>',
				esc_html(
					sprintf(
						/* translators: %d: number of topics. */
						_n(
							'%d FAQ topic still has no answer. Until it is written and approved, the assistant will say it does not have verified information.',
							'%d FAQ topics still have no answer. Until they are written and approved, the assistant will say it does not have verified information.',
							count( $unanswered ),
							'wellness-chatbot'
						),
						count( $unanswered )
					)
				)
			);
		}

		echo '<p class="description">' . esc_html__( 'Every answer needs English and Arabic text, and must be approved before a customer can see it. Arabic should be reviewed by a fluent speaker, not machine-translated.', 'wellness-chatbot' ) . '</p>';

		self::render_form( null );

		echo '<h2>' . esc_html__( 'Entries', 'wellness-chatbot' ) . '</h2>';
		foreach ( $entries as $entry ) {
			self::render_form( $entry );
		}
	}

	/**
	 * @param array|null $entry Existing entry, or null for the "add new" form.
	 */
	private static function render_form( $entry ) {
		$is_new    = null === $entry;
		$id        = $is_new ? 0 : (int) $entry['id'];
		$approved  = ! $is_new && ! empty( $entry['approved'] );
		$has_both  = ! $is_new && ! empty( $entry['answer_en'] ) && ! empty( $entry['answer_ar'] );

		echo '<div class="wwc-kb-entry' . ( $approved ? ' wwc-approved' : '' ) . '">';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'wwc_save_kb' );
		echo '<input type="hidden" name="action" value="wwc_save_kb" />';
		printf( '<input type="hidden" name="id" value="%d" />', (int) $id );

		echo '<h3>';
		echo esc_html( $is_new ? __( 'Add a topic', 'wellness-chatbot' ) : (string) $entry['topic'] );
		if ( ! $is_new ) {
			printf(
				' <span class="wwc-flag %s">%s</span>',
				$approved ? 'wwc-flag-ok' : 'wwc-flag-warn',
				esc_html( $approved ? __( 'approved', 'wellness-chatbot' ) : __( 'not approved', 'wellness-chatbot' ) )
			);
		}
		echo '</h3>';

		printf(
			'<p><label>%s<br /><input type="text" name="topic" class="widefat" value="%s" required /></label></p>',
			esc_html__( 'Topic', 'wellness-chatbot' ),
			esc_attr( $is_new ? '' : (string) $entry['topic'] )
		);

		echo '<div class="wwc-bilingual">';
		printf(
			'<p><label>%s<br /><input type="text" name="question_en" class="widefat" value="%s" /></label></p>',
			esc_html__( 'Question (English)', 'wellness-chatbot' ),
			esc_attr( $is_new ? '' : (string) $entry['question_en'] )
		);
		printf(
			'<p dir="rtl"><label>%s<br /><input type="text" name="question_ar" class="widefat" value="%s" /></label></p>',
			esc_html__( 'Question (Arabic)', 'wellness-chatbot' ),
			esc_attr( $is_new ? '' : (string) $entry['question_ar'] )
		);
		echo '</div>';

		echo '<div class="wwc-bilingual">';
		printf(
			'<p><label>%s<br /><textarea name="answer_en" rows="4" class="widefat">%s</textarea></label></p>',
			esc_html__( 'Answer (English)', 'wellness-chatbot' ),
			esc_textarea( $is_new ? '' : (string) $entry['answer_en'] )
		);
		printf(
			'<p dir="rtl"><label>%s<br /><textarea name="answer_ar" rows="4" class="widefat">%s</textarea></label></p>',
			esc_html__( 'Answer (Arabic)', 'wellness-chatbot' ),
			esc_textarea( $is_new ? '' : (string) $entry['answer_ar'] )
		);
		echo '</div>';

		printf(
			'<p><label><input type="checkbox" name="approved" value="1"%s%s /> %s</label></p>',
			checked( $approved, true, false ),
			$is_new ? '' : ( $has_both ? '' : ' disabled="disabled"' ),
			esc_html__( 'Approved — the assistant may use this answer', 'wellness-chatbot' )
		);

		if ( ! $is_new && ! $has_both ) {
			echo '<p class="description">' . esc_html__( 'Both languages need an answer before this entry can be approved.', 'wellness-chatbot' ) . '</p>';
		}

		if ( ! $is_new ) {
			printf(
				'<p class="wwc-meta">%s</p>',
				esc_html(
					sprintf(
						/* translators: 1: date, 2: user login. */
						__( 'Last edited %1$s by %2$s', 'wellness-chatbot' ),
						(string) $entry['updated_at'],
						$entry['updated_by'] ? (string) $entry['updated_by'] : __( 'unknown', 'wellness-chatbot' )
					)
				)
			);
		}

		printf( '<button type="submit" class="button button-primary">%s</button>', esc_html__( 'Save', 'wellness-chatbot' ) );
		echo '</form>';

		if ( ! $is_new ) {
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="wwc-inline-form">';
			wp_nonce_field( 'wwc_delete_kb' );
			echo '<input type="hidden" name="action" value="wwc_delete_kb" />';
			printf( '<input type="hidden" name="id" value="%d" />', (int) $id );
			printf( '<button type="submit" class="button-link wwc-confirm-delete">%s</button>', esc_html__( 'Delete', 'wellness-chatbot' ) );
			echo '</form>';
		}

		echo '</div>';
	}

	public static function handle_save() {
		WWC_Admin::verify_post( 'wwc_save_kb' );

		$payload = array(
			'id'          => isset( $_POST['id'] ) ? (int) $_POST['id'] : 0,
			'topic'       => isset( $_POST['topic'] ) ? sanitize_text_field( wp_unslash( $_POST['topic'] ) ) : '',
			'question_en' => isset( $_POST['question_en'] ) ? sanitize_text_field( wp_unslash( $_POST['question_en'] ) ) : '',
			'question_ar' => isset( $_POST['question_ar'] ) ? sanitize_text_field( wp_unslash( $_POST['question_ar'] ) ) : '',
			'answer_en'   => isset( $_POST['answer_en'] ) ? sanitize_textarea_field( wp_unslash( $_POST['answer_en'] ) ) : '',
			'answer_ar'   => isset( $_POST['answer_ar'] ) ? sanitize_textarea_field( wp_unslash( $_POST['answer_ar'] ) ) : '',
			'approved'    => ! empty( $_POST['approved'] ),
		);

		if ( 0 === $payload['id'] ) {
			unset( $payload['id'] );
		}

		// An entry missing either language must not be approvable, whatever the
		// form posted.
		if ( '' === $payload['answer_en'] || '' === $payload['answer_ar'] ) {
			$payload['approved'] = false;
		}

		$response = WWC_Backend_Client::post( '/api/admin/kb', $payload );

		// The config cache holds questionnaire data; KB answers are read live.
		delete_transient( 'wwc_questionnaire_config' );

		WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => is_wp_error( $response ) ? 'failed' : 'saved' ) );
	}

	public static function handle_delete() {
		WWC_Admin::verify_post( 'wwc_delete_kb' );
		$id       = isset( $_POST['id'] ) ? (int) $_POST['id'] : 0;
		$response = WWC_Backend_Client::post( '/api/admin/kb', array( 'delete_id' => $id ) );
		WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => is_wp_error( $response ) ? 'failed' : 'saved' ) );
	}
}
