<?php
/**
 * Version history (spec §8.6).
 *
 * A lightweight audit trail of who changed what and when, for policy and
 * safety-relevant content — the source document's QA requirement to keep
 * version history and approval dates.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Admin_History {

	const PAGE = 'wellness-chatbot-history';

	public static function init() {
		// Read-only screen.
	}

	public static function render() {
		WWC_Admin::page( __( 'Version History', 'wellness-chatbot' ), array( __CLASS__, 'body' ) );
	}

	public static function body() {
		$entity = isset( $_GET['entity'] ) ? sanitize_key( wp_unslash( $_GET['entity'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended

		self::render_filters( $entity );

		$query = array( 'limit' => 200 );
		if ( '' !== $entity ) {
			$query['entity'] = $entity;
			// The backend pairs entity with entity_id; passing a wildcard id keeps
			// the filter meaningful without needing a specific record.
			$query['entity_id'] = '';
			unset( $query['entity_id'] );
		}

		$result = WWC_Backend_Client::get( '/api/admin/audit', $query );
		if ( is_wp_error( $result ) ) {
			WWC_Admin::error_notice( $result );
			return;
		}

		$rows = isset( $result['rows'] ) && is_array( $result['rows'] ) ? $result['rows'] : array();
		if ( '' !== $entity ) {
			$rows = array_values(
				array_filter(
					$rows,
					function ( $row ) use ( $entity ) {
						return isset( $row['entity'] ) && $entity === $row['entity'];
					}
				)
			);
		}

		if ( empty( $rows ) ) {
			echo '<p>' . esc_html__( 'No history recorded yet.', 'wellness-chatbot' ) . '</p>';
			return;
		}

		echo '<table class="widefat striped"><thead><tr>';
		echo '<th>' . esc_html__( 'When', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'What', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Action', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Who', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Detail', 'wellness-chatbot' ) . '</th>';
		echo '</tr></thead><tbody>';

		foreach ( $rows as $row ) {
			echo '<tr>';
			printf( '<td>%s</td>', esc_html( isset( $row['created_at'] ) ? (string) $row['created_at'] : '' ) );
			printf(
				'<td>%s</td>',
				esc_html( sprintf( '%s #%s', isset( $row['entity'] ) ? (string) $row['entity'] : '', isset( $row['entity_id'] ) ? (string) $row['entity_id'] : '' ) )
			);
			printf( '<td><code>%s</code></td>', esc_html( isset( $row['action'] ) ? (string) $row['action'] : '' ) );
			printf( '<td>%s</td>', esc_html( isset( $row['actor'] ) && $row['actor'] ? (string) $row['actor'] : __( 'system', 'wellness-chatbot' ) ) );
			printf(
				'<td><code class="wwc-detail">%s</code></td>',
				esc_html( isset( $row['detail'] ) ? wp_json_encode( $row['detail'] ) : '' )
			);
			echo '</tr>';
		}

		echo '</tbody></table>';
	}

	private static function render_filters( $entity ) {
		$base = admin_url( 'admin.php?page=' . self::PAGE );
		echo '<ul class="subsubsub">';
		foreach ( array(
			''            => __( 'Everything', 'wellness-chatbot' ),
			'product'     => __( 'Products', 'wellness-chatbot' ),
			'kb'          => __( 'Knowledge base', 'wellness-chatbot' ),
			'settings'    => __( 'Settings', 'wellness-chatbot' ),
			'label_draft' => __( 'Label drafts', 'wellness-chatbot' ),
			'escalation'  => __( 'Escalations', 'wellness-chatbot' ),
		) as $key => $label ) {
			printf(
				'<li><a href="%s"%s>%s</a> | </li>',
				esc_url( '' === $key ? $base : add_query_arg( 'entity', $key, $base ) ),
				$entity === $key ? ' class="current"' : '',
				esc_html( $label )
			);
		}
		echo '</ul><div class="clear"></div>';
	}
}
