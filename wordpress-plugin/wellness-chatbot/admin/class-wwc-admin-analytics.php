<?php
/**
 * Analytics dashboard (spec §8.4, §14).
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Admin_Analytics {

	const PAGE = 'wellness-chatbot-analytics';

	public static function init() {
		// Read-only screen; nothing to hook.
	}

	public static function render() {
		WWC_Admin::page( __( 'Analytics', 'wellness-chatbot' ), array( __CLASS__, 'body' ) );
	}

	public static function body() {
		$days   = isset( $_GET['days'] ) ? max( 1, (int) $_GET['days'] ) : 30; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$result = WWC_Backend_Client::get( '/api/admin/analytics', array( 'days' => $days ) );

		if ( is_wp_error( $result ) ) {
			WWC_Admin::error_notice( $result );
			return;
		}

		self::render_range_links( $days );

		$kpis = array(
			array( __( 'Sessions', 'wellness-chatbot' ), self::value( $result, 'sessions' ), '' ),
			array( __( 'Questionnaire completion', 'wellness-chatbot' ), self::value( $result, 'questionnaire_completion_rate' ), '%' ),
			array( __( 'Recommendation click-through', 'wellness-chatbot' ), self::value( $result, 'recommendation_click_through_rate' ), '%' ),
			array( __( 'Add to cart after recommendation', 'wellness-chatbot' ), self::value( $result, 'add_to_cart_rate' ), '%' ),
			array( __( 'No-answer rate', 'wellness-chatbot' ), self::value( $result, 'no_answer_rate' ), '%' ),
			array( __( 'Helpfulness score', 'wellness-chatbot' ), self::value( $result, 'helpfulness_score' ), '%' ),
			array( __( 'Incorrect-answer reports', 'wellness-chatbot' ), self::value( $result, 'incorrect_answer_reports' ), '' ),
		);

		echo '<div class="wwc-cards wwc-cards-kpi">';
		foreach ( $kpis as $kpi ) {
			printf(
				'<div class="wwc-card"><span class="wwc-card-value">%s%s</span><span class="wwc-card-label">%s</span></div>',
				esc_html( (string) $kpi[1] ),
				esc_html( $kpi[2] ),
				esc_html( $kpi[0] )
			);
		}
		echo '</div>';

		self::render_down_reasons( $result );
		self::render_top_products( $result );

		echo '<h2>' . esc_html__( 'Review cadence', 'wellness-chatbot' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'Review failed conversations weekly during launch and monthly once stable. Classify each failure (missing data, wrong intent, unsafe answer, poor recommendation, unclear wording, integration error) and fix it in the knowledge base or product data — not only in the prompt.', 'wellness-chatbot' ) . '</p>';
	}

	private static function value( array $result, $key ) {
		return isset( $result[ $key ] ) ? $result[ $key ] : 0;
	}

	private static function render_range_links( $days ) {
		$base = admin_url( 'admin.php?page=' . self::PAGE );
		echo '<ul class="subsubsub">';
		foreach ( array( 7, 30, 90 ) as $option ) {
			printf(
				'<li><a href="%s"%s>%s</a> | </li>',
				esc_url( add_query_arg( 'days', $option, $base ) ),
				$days === $option ? ' class="current"' : '',
				esc_html( sprintf( /* translators: %d: number of days. */ __( 'Last %d days', 'wellness-chatbot' ), $option ) )
			);
		}
		echo '</ul><div class="clear"></div>';
	}

	private static function render_down_reasons( array $result ) {
		$reasons = isset( $result['feedback_down_reasons'] ) && is_array( $result['feedback_down_reasons'] )
			? $result['feedback_down_reasons']
			: array();

		echo '<h2>' . esc_html__( 'What customers marked unhelpful', 'wellness-chatbot' ) . '</h2>';
		if ( empty( $reasons ) ) {
			echo '<p>' . esc_html__( 'No thumbs-down reasons in this period.', 'wellness-chatbot' ) . '</p>';
			return;
		}

		echo '<table class="widefat striped"><thead><tr>';
		echo '<th>' . esc_html__( 'Reason', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Count', 'wellness-chatbot' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $reasons as $reason ) {
			printf(
				'<tr><td>%s</td><td>%d</td></tr>',
				esc_html( isset( $reason['reason'] ) ? (string) $reason['reason'] : '' ),
				isset( $reason['count'] ) ? (int) $reason['count'] : 0
			);
		}
		echo '</tbody></table>';
	}

	private static function render_top_products( array $result ) {
		$rows = isset( $result['top_added_to_cart'] ) && is_array( $result['top_added_to_cart'] )
			? $result['top_added_to_cart']
			: array();

		echo '<h2>' . esc_html__( 'Most added to cart from a recommendation', 'wellness-chatbot' ) . '</h2>';
		if ( empty( $rows ) ) {
			echo '<p>' . esc_html__( 'No add-to-cart events in this period.', 'wellness-chatbot' ) . '</p>';
			return;
		}

		echo '<table class="widefat striped"><thead><tr>';
		echo '<th>' . esc_html__( 'Product', 'wellness-chatbot' ) . '</th>';
		echo '<th>' . esc_html__( 'Added to cart', 'wellness-chatbot' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $rows as $row ) {
			$product_id = isset( $row['product_id'] ) ? (int) $row['product_id'] : 0;
			$product    = $product_id ? wc_get_product( $product_id ) : null;
			printf(
				'<tr><td>%s</td><td>%d</td></tr>',
				$product
					? sprintf(
						'<a href="%s">%s</a>',
						esc_url( (string) get_edit_post_link( $product_id ) ),
						esc_html( $product->get_name() )
					)
					: esc_html( sprintf( '#%d', $product_id ) ),
				isset( $row['count'] ) ? (int) $row['count'] : 0
			);
		}
		echo '</tbody></table>';
		echo '<p class="description">' . esc_html__( 'Cross-reference these against returns once a returns process exists, so a product that is recommended often but returned often gets caught.', 'wellness-chatbot' ) . '</p>';
	}
}
