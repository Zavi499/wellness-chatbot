<?php
/**
 * Uninstall routine.
 *
 * Deliberately conservative: plugin settings go, but the `_wwc_*` product data
 * a pharmacist verified stays. Deleting verified medical-adjacent labeling on
 * an uninstall would destroy work that is expensive and safety-relevant to
 * recreate. A site owner who genuinely wants it gone can clear the meta keys.
 *
 * @package WellnessChatbot
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

$options = array(
	'wwc_backend_url',
	'wwc_shared_secret',
	'wwc_auto_inject',
	'wwc_business_settings',
	'wwc_relabel_on_save',
	'wwc_setup_complete',
	'wwc_caps_version',
);

foreach ( $options as $option ) {
	delete_option( $option );
}

delete_transient( 'wwc_questionnaire_config' );
delete_transient( 'wwc_show_setup_notice' );
delete_transient( 'wwc_open_emergencies' );

// Remove the reviewer role but leave the capability on any user who was granted
// it directly, so a re-install does not silently drop a person's access.
remove_role( 'wwc_pharmacist' );

$admin = get_role( 'administrator' );
if ( $admin ) {
	$admin->remove_cap( 'wwc_manage_chatbot' );
}

$shop_manager = get_role( 'shop_manager' );
if ( $shop_manager ) {
	$shop_manager->remove_cap( 'wwc_manage_chatbot' );
}
