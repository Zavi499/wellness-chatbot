<?php
/**
 * Plugin options and the Business Settings facts (spec §8.5).
 *
 * The shared secret is read from wp-config.php first so it need never sit in
 * the options table on a production site.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Settings {

	const OPTION_BACKEND_URL   = 'wwc_backend_url';
	const OPTION_SHARED_SECRET = 'wwc_shared_secret';
	const OPTION_AUTO_INJECT   = 'wwc_auto_inject';
	const OPTION_BUSINESS      = 'wwc_business_settings';
	const OPTION_RELABEL       = 'wwc_relabel_on_save';

	/**
	 * The [TO BE CONFIRMED] facts from the source blueprint. Every one of these
	 * is empty until the store owner fills it in — the assistant reads them live
	 * and says "let me check" rather than stating an unconfirmed value.
	 *
	 * @return array<string,array{label:string,help:string}>
	 */
	public static function business_fields() {
		return array(
			'delivery_areas'          => array(
				'label' => __( 'Delivery areas', 'wellness-chatbot' ),
				'help'  => __( 'Which governorates or areas you deliver to.', 'wellness-chatbot' ),
			),
			'delivery_fee'            => array(
				'label' => __( 'Delivery fee', 'wellness-chatbot' ),
				'help'  => __( 'Standard delivery charge, including the currency.', 'wellness-chatbot' ),
			),
			'free_delivery_threshold' => array(
				'label' => __( 'Free delivery threshold', 'wellness-chatbot' ),
				'help'  => __( 'Order value above which delivery is free. Leave empty if you do not offer this.', 'wellness-chatbot' ),
			),
			'order_cutoff_time'       => array(
				'label' => __( 'Daily order cut-off', 'wellness-chatbot' ),
				'help'  => __( 'The time after which an order ships the next day.', 'wellness-chatbot' ),
			),
			'service_hours'           => array(
				'label' => __( 'Customer service hours', 'wellness-chatbot' ),
				'help'  => __( 'When a human is actually available.', 'wellness-chatbot' ),
			),
			'whatsapp_number'         => array(
				'label' => __( 'WhatsApp number', 'wellness-chatbot' ),
				'help'  => __( 'Used for the human handover deep link. Include the country code.', 'wellness-chatbot' ),
			),
			'phone_number'            => array(
				'label' => __( 'Phone number', 'wellness-chatbot' ),
				'help'  => __( 'Fallback contact shown when WhatsApp is not configured.', 'wellness-chatbot' ),
			),
			'live_chat_note'          => array(
				'label' => __( 'Live chat note', 'wellness-chatbot' ),
				'help'  => __( 'How to reach your live chat, if you run one.', 'wellness-chatbot' ),
			),
			'payment_methods'         => array(
				'label' => __( 'Accepted payment methods', 'wellness-chatbot' ),
				'help'  => __( 'e.g. KNET, Visa, Mastercard, cash on delivery.', 'wellness-chatbot' ),
			),
			'loyalty_rules'           => array(
				'label' => __( 'Loyalty programme rules', 'wellness-chatbot' ),
				'help'  => __( 'How points are earned and redeemed. Leave empty if you have no programme.', 'wellness-chatbot' ),
			),
			'returns_policy'          => array(
				'label' => __( 'Returns / exchange / refund policy', 'wellness-chatbot' ),
				'help'  => __( 'The blueprint recorded "no return / no exchange / no refund" — confirm this is final before launch, because it materially affects customer trust.', 'wellness-chatbot' ),
			),
			'currency'                => array(
				'label' => __( 'Currency', 'wellness-chatbot' ),
				'help'  => __( 'Currency code shown with prices, e.g. KWD.', 'wellness-chatbot' ),
			),
		);
	}

	public static function backend_url() {
		if ( defined( 'WELLNESS_CHATBOT_BACKEND_URL' ) && WELLNESS_CHATBOT_BACKEND_URL ) {
			return untrailingslashit( WELLNESS_CHATBOT_BACKEND_URL );
		}
		return untrailingslashit( (string) get_option( self::OPTION_BACKEND_URL, '' ) );
	}

	/**
	 * Prefers the wp-config.php constant. Falls back to the option so a site
	 * without file access can still be configured, with a warning in the UI.
	 */
	public static function shared_secret() {
		if ( defined( 'WELLNESS_CHATBOT_SECRET' ) && WELLNESS_CHATBOT_SECRET ) {
			return (string) WELLNESS_CHATBOT_SECRET;
		}
		return (string) get_option( self::OPTION_SHARED_SECRET, '' );
	}

	public static function secret_in_config() {
		return defined( 'WELLNESS_CHATBOT_SECRET' ) && WELLNESS_CHATBOT_SECRET;
	}

	public static function auto_inject() {
		return '1' === (string) get_option( self::OPTION_AUTO_INJECT, '0' );
	}

	public static function relabel_on_save() {
		return '1' === (string) get_option( self::OPTION_RELABEL, '0' );
	}

	/**
	 * @return array<string,string>
	 */
	public static function business() {
		$stored = get_option( self::OPTION_BUSINESS, array() );
		return is_array( $stored ) ? $stored : array();
	}

	public static function business_value( $key ) {
		$all = self::business();
		return isset( $all[ $key ] ) ? (string) $all[ $key ] : '';
	}

	/**
	 * Which facts are still unconfirmed. Drives the launch checklist notice.
	 *
	 * @return string[]
	 */
	public static function missing_business_fields() {
		$missing = array();
		foreach ( self::business_fields() as $key => $field ) {
			if ( 'currency' === $key ) {
				continue;
			}
			if ( '' === trim( self::business_value( $key ) ) ) {
				$missing[] = $key;
			}
		}
		return $missing;
	}

	public static function is_connected() {
		return '' !== self::backend_url() && '' !== self::shared_secret();
	}
}
