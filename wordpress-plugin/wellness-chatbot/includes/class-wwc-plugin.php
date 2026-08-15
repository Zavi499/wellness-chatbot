<?php
/**
 * Plugin container. Wires the integration pieces together and keeps each
 * concern in its own class.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Plugin {

	/**
	 * @var WWC_Plugin|null
	 */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		load_plugin_textdomain( 'wellness-chatbot', false, dirname( plugin_basename( WWC_FILE ) ) . '/languages' );

		WWC_Meta::init();
		WWC_Roles::init();
		WWC_Rest::init();
		WWC_Queue::init();
		WWC_Webhooks::init();
		WWC_Widget::init();

		if ( is_admin() ) {
			WWC_Admin::init();
		}

		add_action( 'admin_notices', array( $this, 'setup_notice' ) );
	}

	/**
	 * One-time nudge after activation: the plugin cannot work until the backend
	 * URL and shared secret exist.
	 */
	public function setup_notice() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		if ( ! get_transient( 'wwc_show_setup_notice' ) ) {
			return;
		}
		if ( WWC_Settings::backend_url() && WWC_Settings::shared_secret() ) {
			delete_transient( 'wwc_show_setup_notice' );
			return;
		}

		printf(
			'<div class="notice notice-warning is-dismissible"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__( 'Wellness Chatbot is installed but not connected yet — add the backend URL and shared secret.', 'wellness-chatbot' ),
			esc_url( admin_url( 'admin.php?page=wellness-chatbot-settings' ) ),
			esc_html__( 'Open settings', 'wellness-chatbot' )
		);
	}
}
