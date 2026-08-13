<?php
/**
 * Plugin Name:       Wellness Chatbot
 * Plugin URI:        https://www.wellnesspharmacykw.com/
 * Description:       AI shopping assistant for Wellness World — product finder, verified FAQ answers, and pharmacist-gated safety escalation. Thin integration layer; the AI orchestration runs in the companion backend service.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      8.0
 * Author:            Wellness World
 * Text Domain:       wellness-chatbot
 * Domain Path:       /languages
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

define( 'WWC_VERSION', '0.1.0' );
define( 'WWC_FILE', __FILE__ );
define( 'WWC_PATH', plugin_dir_path( __FILE__ ) );
define( 'WWC_URL', plugin_dir_url( __FILE__ ) );

/**
 * PSR-ish autoloader for the plugin's `WWC_` classes.
 *
 * WWC_Admin_Labels  -> admin/class-wwc-admin-labels.php
 * WWC_Backend_Client-> includes/class-wwc-backend-client.php
 */
spl_autoload_register(
	function ( $class ) {
		if ( 0 !== strpos( $class, 'WWC_' ) ) {
			return;
		}

		$slug = 'class-' . str_replace( '_', '-', strtolower( $class ) ) . '.php';
		$dirs = array( WWC_PATH . 'includes/', WWC_PATH . 'admin/' );

		foreach ( $dirs as $dir ) {
			$file = $dir . $slug;
			if ( file_exists( $file ) ) {
				require_once $file;
				return;
			}
		}
	}
);

/**
 * Boots the plugin once WooCommerce is known to be present.
 */
function wwc_bootstrap() {
	if ( ! class_exists( 'WooCommerce' ) ) {
		add_action(
			'admin_notices',
			function () {
				echo '<div class="notice notice-error"><p>';
				esc_html_e( 'Wellness Chatbot needs WooCommerce to be active.', 'wellness-chatbot' );
				echo '</p></div>';
			}
		);
		return;
	}

	WWC_Plugin::instance();
}
add_action( 'plugins_loaded', 'wwc_bootstrap', 20 );

register_activation_hook(
	__FILE__,
	function () {
		require_once WWC_PATH . 'includes/class-wwc-roles.php';
		WWC_Roles::add_capabilities();

		// The backend is where secrets live; surface a setup reminder rather
		// than guessing a URL or generating a secret the admin cannot see.
		if ( ! get_option( 'wwc_setup_complete' ) ) {
			set_transient( 'wwc_show_setup_notice', 1, DAY_IN_SECONDS );
		}
		flush_rewrite_rules();
	}
);

register_deactivation_hook(
	__FILE__,
	function () {
		flush_rewrite_rules();
	}
);
