<?php
/**
 * Escalation Log (spec §8.3, §5.3).
 *
 * Every emergency and pharmacist-review escalation, with the transcript, so a
 * human can pick the conversation up without the customer repeating themselves.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Admin_Escalations {

	const PAGE = 'wellness-chatbot-escalations';

	public static function init() {
		add_action( 'admin_post_wwc_resolve_escalation', array( __CLASS__, 'handle_resolve' ) );
		add_action( 'admin_notices', array( __CLASS__, 'open_emergency_notice' ) );
	}

	public static function render() {
		WWC_Admin::page( __( 'Escalation Log', 'wellness-chatbot' ), array( __CLASS__, 'body' ) );
	}

	public static function body() {
		WWC_Admin::render_notice_from_query();

		$status  = isset( $_GET['status'] ) ? sanitize_key( wp_unslash( $_GET['status'] ) ) : 'open'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$urgency = isset( $_GET['urgency'] ) ? sanitize_key( wp_unslash( $_GET['urgency'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended

		self::render_filters( $status, $urgency );

		$query = array( 'limit' => 50 );
		if ( '' !== $status && 'all' !== $status ) {
			$query['status'] = $status;
		}
		if ( '' !== $urgency ) {
			$query['urgency'] = $urgency;
		}

		$result = WWC_Backend_Client::get( '/api/admin/escalations', $query );
		if ( is_wp_error( $result ) ) {
			WWC_Admin::error_notice( $result );
			return;
		}

		$rows = isset( $result['rows'] ) && is_array( $result['rows'] ) ? $result['rows'] : array();

		if ( empty( $rows ) ) {
			echo '<p>' . esc_html__( 'No escalations match this filter.', 'wellness-chatbot' ) . '</p>';
			return;
		}

		foreach ( $rows as $row ) {
			self::render_row( $row );
		}
	}

	private static function render_filters( $status, $urgency ) {
		$base = admin_url( 'admin.php?page=' . self::PAGE );

		echo '<ul class="subsubsub">';
		foreach ( array(
			'open'     => __( 'Open', 'wellness-chatbot' ),
			'resolved' => __( 'Resolved', 'wellness-chatbot' ),
			'all'      => __( 'All', 'wellness-chatbot' ),
		) as $key => $label ) {
			printf(
				'<li><a href="%s"%s>%s</a> | </li>',
				esc_url( add_query_arg( 'status', $key, $base ) ),
				$status === $key ? ' class="current"' : '',
				esc_html( $label )
			);
		}
		foreach ( array(
			''                  => __( 'Any urgency', 'wellness-chatbot' ),
			'emergency'         => __( 'Emergency', 'wellness-chatbot' ),
			'pharmacist_review' => __( 'Pharmacist review', 'wellness-chatbot' ),
		) as $key => $label ) {
			printf(
				'<li><a href="%s"%s>%s</a> | </li>',
				esc_url( add_query_arg( array( 'status' => $status, 'urgency' => $key ), $base ) ),
				$urgency === $key ? ' class="current"' : '',
				esc_html( $label )
			);
		}
		echo '</ul><div class="clear"></div>';
	}

	private static function render_row( array $row ) {
		$urgency    = isset( $row['urgency'] ) ? (string) $row['urgency'] : '';
		$emergency  = 'emergency' === $urgency;
		$transcript = isset( $row['transcript'] ) && is_array( $row['transcript'] ) ? $row['transcript'] : array();
		$resolved   = isset( $row['status'] ) && 'resolved' === $row['status'];

		echo '<div class="wwc-escalation' . ( $emergency ? ' wwc-emergency' : '' ) . '">';

		printf(
			'<h2>%s <span class="wwc-flag %s">%s</span></h2>',
			esc_html( isset( $row['reason'] ) ? (string) $row['reason'] : '' ),
			$emergency ? 'wwc-flag-danger' : 'wwc-flag-warn',
			esc_html( $emergency ? __( 'Emergency', 'wellness-chatbot' ) : __( 'Pharmacist review', 'wellness-chatbot' ) )
		);

		printf(
			'<p class="wwc-meta">%s &middot; %s &middot; %s</p>',
			esc_html( isset( $row['created_at'] ) ? (string) $row['created_at'] : '' ),
			esc_html(
				sprintf(
					/* translators: %s: rule or model. */
					__( 'triggered by %s', 'wellness-chatbot' ),
					isset( $row['trigger_source'] ) ? (string) $row['trigger_source'] : ''
				)
			),
			esc_html(
				sprintf(
					/* translators: %s: session id. */
					__( 'session %s', 'wellness-chatbot' ),
					isset( $row['session_id'] ) ? substr( (string) $row['session_id'], 0, 8 ) : ''
				)
			)
		);

		echo '<details><summary>' . esc_html__( 'Transcript', 'wellness-chatbot' ) . '</summary><div class="wwc-transcript">';
		foreach ( $transcript as $turn ) {
			printf(
				'<p class="wwc-turn wwc-turn-%s"><strong>%s:</strong> %s</p>',
				esc_attr( isset( $turn['role'] ) ? (string) $turn['role'] : 'user' ),
				esc_html( isset( $turn['role'] ) && 'assistant' === $turn['role'] ? __( 'Assistant', 'wellness-chatbot' ) : __( 'Customer', 'wellness-chatbot' ) ),
				esc_html( isset( $turn['content'] ) ? (string) $turn['content'] : '' )
			);
		}
		echo '</div></details>';

		if ( $resolved ) {
			printf(
				'<p class="wwc-resolved">%s %s</p>',
				esc_html__( 'Resolved:', 'wellness-chatbot' ),
				esc_html( isset( $row['resolution_note'] ) ? (string) $row['resolution_note'] : '' )
			);
		} else {
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="wwc-resolve-form">';
			wp_nonce_field( 'wwc_resolve_escalation' );
			echo '<input type="hidden" name="action" value="wwc_resolve_escalation" />';
			printf( '<input type="hidden" name="id" value="%d" />', isset( $row['id'] ) ? (int) $row['id'] : 0 );
			printf(
				'<input type="text" name="note" class="regular-text" placeholder="%s" /> ',
				esc_attr__( 'How was it followed up?', 'wellness-chatbot' )
			);
			printf( '<button type="submit" class="button">%s</button>', esc_html__( 'Mark resolved', 'wellness-chatbot' ) );
			echo '</form>';
		}

		echo '</div>';
	}

	public static function handle_resolve() {
		WWC_Admin::verify_post( 'wwc_resolve_escalation' );

		$id   = isset( $_POST['id'] ) ? (int) $_POST['id'] : 0;
		$note = isset( $_POST['note'] ) ? sanitize_text_field( wp_unslash( $_POST['note'] ) ) : '';

		$response = WWC_Backend_Client::post( '/api/admin/escalations/' . $id . '/resolve', array( 'note' => $note ) );
		delete_transient( 'wwc_open_emergencies' );

		WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => is_wp_error( $response ) ? 'failed' : 'resolved' ) );
	}

	/**
	 * An unresolved emergency is the one thing worth interrupting an admin for,
	 * wherever they are in wp-admin.
	 */
	public static function open_emergency_notice() {
		if ( ! WWC_Roles::can_manage() ) {
			return;
		}

		$count = get_transient( 'wwc_open_emergencies' );
		if ( false === $count ) {
			$result = WWC_Backend_Client::get(
				'/api/admin/escalations',
				array( 'status' => 'open', 'urgency' => 'emergency', 'limit' => 20 )
			);
			$count = ( ! is_wp_error( $result ) && isset( $result['rows'] ) ) ? count( $result['rows'] ) : 0;
			set_transient( 'wwc_open_emergencies', $count, 5 * MINUTE_IN_SECONDS );
		}

		if ( (int) $count < 1 ) {
			return;
		}

		printf(
			'<div class="notice notice-error"><p><strong>%s</strong> <a href="%s">%s</a></p></div>',
			esc_html(
				sprintf(
					/* translators: %d: number of escalations. */
					_n(
						'%d emergency escalation is waiting for follow-up.',
						'%d emergency escalations are waiting for follow-up.',
						(int) $count,
						'wellness-chatbot'
					),
					(int) $count
				)
			),
			esc_url( admin_url( 'admin.php?page=' . self::PAGE ) ),
			esc_html__( 'Open the escalation log', 'wellness-chatbot' )
		);
	}
}
